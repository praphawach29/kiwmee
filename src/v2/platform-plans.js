// /super: the platform admin manages a brand's plan and wallet (B7, docs/BILLING_PLAN.md 3.6).
// Every action first proves the signed-in person is a platform admin, then runs on the server's own
// connection (ownerTx) and writes what changed and why to platform_plan_changes (migration …004400).

const { AppError, badRequest, notFound } = require("../errors");
const { requirePlatformAdminId } = require("./platform-settings");
const { ownerTx } = require("./wallet");
const { PLANS } = require("./plans");

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PLAN_IDS = PLANS.map((p) => p.id);
const invalid = (message) => new AppError("INVALID", message, 422);

function brandIdOf(value) {
  if (typeof value !== "string" || !UUID.test(value)) throw badRequest("แบรนด์ไม่ถูกต้อง");
  return value;
}

function reasonOf(value) {
  const reason = typeof value === "string" ? value.trim() : "";
  if (reason.length < 3 || reason.length > 300) throw invalid("ใส่เหตุผล 3–300 ตัวอักษร (เก็บไว้ในประวัติ)");
  return reason;
}

/** "2027-01-31" (Bangkok end of day) or an ISO time → Date; null / "" → null (no end date) */
function endOf(value) {
  if (value === null || value === undefined || value === "") return null;
  const text = String(value);
  const date = /^\d{4}-\d{2}-\d{2}$/.test(text) ? new Date(`${text}T23:59:59+07:00`) : new Date(text);
  if (Number.isNaN(date.getTime())) throw invalid("วันหมดอายุไม่ถูกต้อง");
  return date;
}

const planState = async (client, brandId) =>
  (await client.query(
    `select p.plan, p.cycle, p.valid_until, p.complimentary, p.trial, p.auto_renew, p.next_plan, p.grace_until,
            public.brand_plan(p.brand_id) as effective
       from public.brand_plans p where p.brand_id = $1`,
    [brandId]
  )).rows[0] ?? null;

/** Everything /super shows for one brand: plan, wallet, latest money movements and admin changes */
async function brandAdmin(userId, brandId) {
  const id = brandIdOf(brandId);
  return ownerTx(async (client) => {
    await requirePlatformAdminId(client, userId);
    const { rows: [brand] } = await client.query("select id, name from public.brands where id = $1", [id]);
    if (!brand) throw notFound("ไม่พบแบรนด์");
    const plan = await planState(client, id);
    const { rows: [account] } = await client.query("select balance::float8 as balance from public.wallet_accounts where brand_id = $1", [id]);
    const { rows: entries } = await client.query(
      `select kind, amount::float8 as amount, balance_after::float8 as balance_after, note, created_at
         from public.wallet_entries where brand_id = $1 order by created_at desc limit 10`,
      [id]
    );
    const { rows: changes } = await client.query(
      `select c.action, c.detail, c.reason, c.created_at, u.email as admin_email
         from public.platform_plan_changes c left join auth.users u on u.id = c.admin_id
        where c.brand_id = $1 order by c.created_at desc limit 10`,
      [id]
    );
    const { rows: [trial] } = await client.query(
      "select t.started_at from public.plan_trials t join public.brand_members m on m.user_id = t.user_id where m.brand_id = $1 limit 1",
      [id]
    );
    return { brand, plan, balance: account?.balance ?? 0, entries, changes, trialUsedAt: trial?.started_at ?? null };
  });
}

/**
 * Put a brand on a plan: { plan, validUntil (date, or null = no end), complimentary, reason }.
 * Clears the trial / grace / scheduled change, then pauses or resumes what the plan covers.
 */
async function setBrandPlan(userId, brandId, input = {}) {
  const id = brandIdOf(brandId);
  if (!PLAN_IDS.includes(input.plan)) throw invalid("เลือกแพ็กเกจ");
  const reason = reasonOf(input.reason);
  const validUntil = endOf(input.validUntil);
  if (input.plan !== "free" && validUntil && validUntil <= new Date()) throw invalid("วันหมดอายุต้องเป็นวันในอนาคต");
  const complimentary = input.plan !== "free" && input.complimentary === true;
  return ownerTx(async (client) => {
    await requirePlatformAdminId(client, userId);
    const before = await planState(client, id);
    if (!before) throw notFound("ไม่พบแบรนด์");
    await client.query(
      `update public.brand_plans
          set plan = $2, valid_until = $3, complimentary = $4, trial = false, grace_until = null,
              next_plan = null, next_cycle = null, auto_renew = $5, cycle = 'month'
        where brand_id = $1`,
      [id, input.plan, input.plan === "free" ? null : validUntil, complimentary, input.plan !== "free" && !complimentary]
    );
    const { rows: [sync] } = await client.query("select public.plan_sync($1) as result", [id]);
    const after = await planState(client, id);
    await client.query(
      "insert into public.platform_plan_changes (brand_id, admin_id, action, detail, reason) values ($1, $2, 'set_plan', $3, $4)",
      [id, userId, JSON.stringify({ before, after, sync: sync.result }), reason]
    );
    return { plan: after, sync: sync.result };
  });
}

/** Add money to a brand's wallet (or take some back): { amount (±, baht), reason } */
async function adjustWallet(userId, brandId, input = {}) {
  const id = brandIdOf(brandId);
  const amount = Number(input.amount);
  if (!Number.isFinite(amount) || amount === 0 || Math.abs(amount) > 100000 || Math.round(amount * 100) !== amount * 100) {
    throw invalid("ยอดต้องไม่เป็น 0 และไม่เกิน ±100,000 บาท (ทศนิยมไม่เกิน 2 ตำแหน่ง)");
  }
  const reason = reasonOf(input.reason);
  return ownerTx(async (client) => {
    await requirePlatformAdminId(client, userId);
    const { rows: [brand] } = await client.query("select 1 from public.brands where id = $1", [id]);
    if (!brand) throw notFound("ไม่พบแบรนด์");
    let result;
    try {
      ({ rows: [{ result }] } = await client.query("select public.wallet_adjust($1, $2, $3, $4) as result", [id, amount, `ทีมงาน: ${reason}`, userId]));
    } catch (error) {
      if (error.message === "INSUFFICIENT_BALANCE") throw invalid("หักได้ไม่เกินยอดที่มีในกระเป๋า");
      throw error;
    }
    await client.query(
      "insert into public.platform_plan_changes (brand_id, admin_id, action, detail, reason) values ($1, $2, 'adjust_wallet', $3, $4)",
      [id, userId, JSON.stringify({ amount, balance: Number(result.balance) }), reason]
    );
    return { balance: Number(result.balance) };
  });
}

/** POST /api/super/brands: { action: "detail" | "set_plan" | "adjust_wallet", brandId, ... } */
async function brandAction(userId, input = {}) {
  if (input.action === "detail") return brandAdmin(userId, input.brandId);
  if (input.action === "set_plan") return setBrandPlan(userId, input.brandId, input);
  if (input.action === "adjust_wallet") return adjustWallet(userId, input.brandId, input);
  throw badRequest("ไม่รู้จักคำสั่งนี้");
}

module.exports = { brandAction, brandAdmin, setBrandPlan, adjustWallet, endOf };
