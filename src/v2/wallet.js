// Wallet (migration …003700): shops pay Kiwmee by transfer, the money lands in a balance attached to
// the brand, and packages / add-ons are bought from it. There is no card gateway yet, so a top-up is
// credited automatically once its slip passes every check (money really arrived, into Kiwmee's
// account, not a reused slip, recent); anything else waits for the platform admin.
//
// Every write goes through this module on the server's own connection (the app connects as the
// database owner). Each call starts by proving the signed-in user owns the brand, so a signed-in
// shop can never reach another brand's wallet, and PostgREST cannot credit anything: the wallet
// tables have no write grants and the RPCs are granted to service_role only.

const { AppError, badRequest, forbidden, notFound } = require("../errors");
const { getBookingPool } = require("./db");
const { getSetting, requirePlatformAdmin, requirePlatformAdminId } = require("./platform-settings");
const { readSlip, receiverMatch } = require("./slip-check");
const { promptPayQr } = require("./promptpay");
const { buildSkus, planCatalog, planById, PLAN_PRICES, PLAN_MESSAGES } = require("./plans");

const DAY = 24 * 3600 * 1000;
const MIN_TOPUP = 100;
const MAX_TOPUP = 20000;
const SLIP_MAX_BYTES = 1_500_000;
const TOPUP_WINDOW_DAYS = 7;

// What can be bought from the balance, by SKU (`apply` says what the purchase changes). Built from
// the one plan table in ./plans.js so prices live in one place.
const SKUS = buildSkus();

const imageError = (message) => new AppError("INVALID", message, 422);

// PLAN_MESSAGES (LINE messages a month) and PLAN_PRICES (baht a month) come from ./plans.js. The
// counter table keeps what was actually granted; PLAN_MESSAGES is the fallback for older brands.

/**
 * What a brand may send this month and how close it is: { used, total, remaining, percent, level }.
 * level = ok | warn (≥ 80%) | full (≥ 100%). Nothing is blocked here — the shop only sees it.
 */
function quotaOf(plan, usage = {}) {
  const included = Math.max(Number(usage.messagesIncluded) || 0, PLAN_MESSAGES[plan] ?? 0);
  const total = included + (Number(usage.messagesPurchased) || 0);
  const used = Number(usage.messagesUsed) || 0;
  const percent = total > 0 ? Math.min(100, Math.round((used / total) * 100)) : 0;
  return {
    used,
    total,
    remaining: Math.max(0, total - used),
    percent,
    level: percent >= 100 ? "full" : percent >= 80 ? "warn" : "ok"
  };
}

/** One transaction on the server's own connection (no RLS): every caller proves brand ownership first. */
async function ownerTx(fn) {
  const client = await getBookingPool().connect();
  try {
    await client.query("begin");
    const result = await fn(client);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function assertOwner(client, brandId, userId) {
  if (typeof brandId !== "string" || !/^[0-9a-f-]{36}$/i.test(brandId)) throw badRequest("แบรนด์ไม่ถูกต้อง");
  const { rows } = await client.query("select 1 from public.brand_members where brand_id = $1 and user_id = $2", [brandId, userId]);
  if (!rows[0]) throw forbidden("เฉพาะเจ้าของแบรนด์เท่านั้น");
  return true;
}

/** The slip against a top-up: enough money for what was asked, to Kiwmee, not reused, recent. */
function judgeTopup(read, { amount, billing, now = new Date() }) {
  if (!read || !read.ok) return { status: "error", reasons: [] };
  const reasons = [];
  if (!read.transRef || read.amount === null) reasons.push("UNREADABLE");
  if (read.amount !== null && Math.round(read.amount * 100) < Math.round(amount * 100)) reasons.push("AMOUNT_LOW");
  if (read.amount !== null && read.amount > MAX_TOPUP) reasons.push("AMOUNT_HIGH");
  const receiver = receiverMatch(billing, read.receiver);
  if (receiver === "mismatch") reasons.push("RECEIVER_MISMATCH");
  if (receiver === "unknown") reasons.push("RECEIVER_UNKNOWN");
  if (read.paidAt) {
    const paid = new Date(read.paidAt).getTime();
    if (paid < now.getTime() - TOPUP_WINDOW_DAYS * DAY) reasons.push("TOO_OLD");
    if (paid > now.getTime() + 10 * 60 * 1000) reasons.push("IN_FUTURE");
  }
  if (read.duplicate) reasons.push("DUPLICATE");
  return { status: reasons.length ? "failed" : "passed", reasons };
}

async function billingInfo(client) {
  const promptPay = await getSetting(client, "billing.promptpay");
  const accountName = await getSetting(client, "billing.account_name");
  const bank = await getSetting(client, "billing.bank");
  return {
    paymentInfo: { promptPay: promptPay ?? undefined, accountNumber: bank?.replace(/[^0-9]/g, "") || undefined, accountName: accountName ?? undefined },
    shown: { promptPay, accountName, bank }
  };
}

async function planOf(client, brandId) {
  const { rows: [row] } = await client.query(
    `select p.plan, p.valid_until, (p.valid_until is not null and p.valid_until < now()) as expired,
            public.brand_plan(p.brand_id) as effective, coalesce(p.complimentary, false) as complimentary
       from public.brand_plans p where p.brand_id = $1`,
    [brandId]
  );
  return row ?? { plan: "free", valid_until: null, expired: false, effective: "free", complimentary: false };
}

async function usageOf(client, brandId) {
  const { rows: [row] } = await client.query(
    `select period::text as period, messages_used, messages_included, messages_purchased, slips_used
       from public.usage_counters
      where brand_id = $1 and period = date_trunc('month', (now() at time zone 'Asia/Bangkok'))::date`,
    [brandId]
  );
  const { rows: [slips] } = await client.query(
    `select coalesce(sum(100), 0)::int as purchased
       from public.wallet_orders
      where brand_id = $1 and sku = 'slip:100' and status = 'paid'
        and created_at >= date_trunc('month', (now() at time zone 'Asia/Bangkok'))`,
    [brandId]
  );
  return {
    period: row?.period ?? null,
    messagesUsed: row?.messages_used ?? 0,
    messagesIncluded: row?.messages_included ?? 0,
    messagesPurchased: row?.messages_purchased ?? 0,
    slipsUsed: row?.slips_used ?? 0,
    slipsPurchased: slips?.purchased ?? 0
  };
}

/**
 * What a brand uses of its plan's limits right now: online bookings made this Bangkok month (the
 * shop's own entries don't count), active resources, people with dashboard access, branches.
 */
async function brandCounts(client, brandId) {
  const { rows: [counts] } = await client.query(
    `select (select count(*)::int from public.bookings k join public.businesses b on b.id = k.business_id
              where b.brand_id = $1 and k.source <> 'admin'
                and k.created_at >= date_trunc('month', (now() at time zone 'Asia/Bangkok')) at time zone 'Asia/Bangkok') as bookings,
            (select count(*)::int from public.resources r join public.businesses b on b.id = r.business_id
              where b.brand_id = $1 and r.active) as resources,
            (select count(distinct m.user_id)::int from public.business_members m join public.businesses b on b.id = m.business_id
              where b.brand_id = $1) as members,
            (select count(*)::int from public.businesses b where b.brand_id = $1) as branches`,
    [brandId]
  );
  return counts ?? { bookings: 0, resources: 0, members: 0, branches: 0 };
}

/** Everything the wallet page shows for one brand. */
async function walletOf(brandId, userId) {
  return ownerTx(async (client) => {
    await assertOwner(client, brandId, userId);
    const [{ rows: [account] }, plan, usage, { rows: entries }, { rows: topups }, { rows: orders }, billing] = await Promise.all([
      client.query("select balance::float8 as balance, updated_at from public.wallet_accounts where brand_id = $1", [brandId]),
      planOf(client, brandId),
      usageOf(client, brandId),
      client.query(
        `select id, kind, amount::float8 as amount, balance_after::float8 as balance_after, note, created_at
           from public.wallet_entries where brand_id = $1 order by created_at desc limit 20`,
        [brandId]
      ),
      client.query(
        `select id, amount::float8 as amount, status, check_status, check_reasons, credit_amount::float8 as credit_amount, created_at, credited_at
           from public.wallet_topups where brand_id = $1 order by created_at desc limit 10`,
        [brandId]
      ),
      client.query(
        `select id, sku, amount::float8 as amount, status, created_at from public.wallet_orders
          where brand_id = $1 order by created_at desc limit 10`,
        [brandId]
      ),
      billingInfo(client)
    ]);
    const counts = await brandCounts(client, brandId);
    const planDaysLeft = plan.valid_until ? Math.ceil((new Date(plan.valid_until) - new Date()) / DAY) : null;
    return {
      balance: account?.balance ?? 0,
      plan,
      planWarn: planDaysLeft == null ? null : planDaysLeft <= 0 ? "หมดอายุแล้ว" : planDaysLeft <= 14 ? `เหลือ ${planDaysLeft} วัน` : null,
      usage,
      quota: quotaOf(plan.effective, usage),
      entries,
      topups,
      orders,
      packs: Object.entries(SKUS).map(([sku, s]) => ({ sku, ...s })),
      catalog: planCatalog(),
      planName: planById(plan.effective).name,
      planDaysLeft,
      counts,
      payTo: billing.shown,
      limits: { min: MIN_TOPUP, max: MAX_TOPUP }
    };
  });
}

function cleanAmount(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < MIN_TOPUP || n > MAX_TOPUP) {
    throw invalidAmount();
  }
  return n;
}

const invalidAmount = () => new AppError("INVALID", `ยอดเติมเงินต้องเป็นจำนวนเต็ม ${MIN_TOPUP}–${MAX_TOPUP} บาท`, 422);

/**
 * The shop sends money, then uploads the slip. If EasySlip reads it and every check passes, the
 * wallet is credited in the same request. Otherwise the slip is kept as "pending" with the reasons,
 * for the platform admin to approve or reject.
 */
async function submitTopup(brandId, userId, { amount, image, mime } = {}) {
  const value = cleanAmount(amount);
  if (!Buffer.isBuffer(image) || !image.length) throw imageError("แนบรูปสลิป");
  if (image.length > SLIP_MAX_BYTES) throw imageError("รูปสลิปใหญ่เกิน 1.5 MB");

  let jpeg;
  let webp;
  try {
    const sharp = require("sharp");
    const input = sharp(image, { failOn: "error" }).rotate();
    jpeg = await input.clone().jpeg({ quality: 80 }).toBuffer();
    webp = await input.clone().webp({ quality: 80 }).toBuffer();
  } catch {
    throw imageError("รูปสลิปอ่านไม่ได้ — ใช้รูป JPEG/PNG/WebP");
  }
  if (!jpeg?.length || jpeg.length > SLIP_MAX_BYTES) throw imageError("รูปสลิปใหญ่เกิน 1.5 MB");

  return ownerTx(async (client) => {
    await assertOwner(client, brandId, userId);
    const billing = await billingInfo(client);
    const read = await readSlip(client, jpeg); // null when no EasySlip key is set
    const verdict = read ? judgeTopup(read, { amount: value, billing: billing.paymentInfo }) : { status: null, reasons: [] };
    const receiverText = read?.ok
      ? [read.receiver?.name, read.receiver?.proxy ?? read.receiver?.account].filter(Boolean).join(" · ") || null
      : null;

    let topup;
    try {
      const { rows: [row] } = await client.query(
        `insert into public.wallet_topups (brand_id, amount, slip, check_status, check_reasons, trans_ref, receiver_text, created_by)
         values ($1, $2, $3, $4, $5, $6, $7, $8)
         returning id, status, amount::float8 as amount`,
        [brandId, value, webp, verdict.status, verdict.reasons, read?.ok ? read.transRef : null, receiverText, userId]
      );
      topup = row;
    } catch (error) {
      if (error.code === "23505") throw new AppError("CONFLICT", "สลิปนี้ถูกใช้เติมเงินไปแล้ว", 409, { reason: "DUPLICATE" });
      throw error;
    }

    if (verdict.status !== "passed") {
      return { status: "pending", topupId: topup.id, reasons: verdict.reasons, checked: Boolean(read), balance: null };
    }

    const { rows: [credited] } = await client.query("select public.wallet_apply_topup($1, $2, $3, $4) as result", [
      topup.id,
      read.amount,
      read.transRef,
      receiverText
    ]);
    return {
      status: "credited",
      topupId: topup.id,
      credited: read.amount,
      balance: Number(credited.result.balance),
      reasons: []
    };
  });
}

/**
 * A PromptPay QR for Kiwmee's account with the top-up amount already in it, so the shop scans it in
 * a bank app instead of typing the number and the amount. null when no PromptPay is set in /super.
 */
async function topupQr(brandId, userId, amount) {
  const value = cleanAmount(amount);
  return ownerTx(async (client) => {
    await assertOwner(client, brandId, userId);
    const billing = await billingInfo(client);
    const qr = await promptPayQr(billing.shown.promptPay, value).catch(() => null);
    return { amount: value, qr, payTo: billing.shown };
  });
}

const RENEW_WITHIN_DAYS = 3;

/**
 * Should this brand's plan renew now? { action: "none" | "renew" | "short", amount }.
 * A paid plan renews when it runs out within 3 days and the wallet covers it; with too little
 * money it is left alone (the shop sees "close to expiry" in the dashboard).
 */
function renewalDecision({ plan, validUntil, balance }, now = new Date()) {
  const price = PLAN_PRICES[plan] ?? 0;
  if (!price) return { action: "none", amount: 0 };
  if (!validUntil) return { action: "none", amount: 0 };
  const left = new Date(validUntil).getTime() - now.getTime();
  if (left <= 0 || left > RENEW_WITHIN_DAYS * DAY) return { action: "none", amount: 0 };
  if ((Number(balance) || 0) < price) return { action: "short", amount: price };
  return { action: "renew", amount: price };
}

/**
 * Renew every paid plan that is about to run out, from the brand's wallet. Runs on the server's
 * clock (instrumentation) — safe to call often: extending 30 days moves it out of the window.
 */
async function renewDuePlans(now = new Date()) {
  return ownerTx(async (client) => {
    const { rows } = await client.query(
      `select p.brand_id, p.plan, p.valid_until, coalesce(a.balance, 0)::float8 as balance
         from public.brand_plans p
         left join public.wallet_accounts a on a.brand_id = p.brand_id
        where p.plan <> 'free' and p.valid_until is not null and not coalesce(p.complimentary, false)
          and p.valid_until <= now() + interval '${RENEW_WITHIN_DAYS} days'`
    );
    let renewed = 0;
    let short = 0;
    for (const row of rows) {
      const decision = renewalDecision(row, now);
      if (decision.action === "short") {
        short += 1;
        console.warn(`[wallet] renewal skipped (wallet ${row.balance} < ${decision.amount}) for brand ${row.brand_id}`);
        continue;
      }
      if (decision.action !== "renew") continue;
      const { rows: [order] } = await client.query(
        "insert into public.wallet_orders (brand_id, sku, amount) values ($1, $2, $3) returning id",
        [row.brand_id, `plan:${row.plan}`, decision.amount]
      );
      await client.query("select public.wallet_charge($1, $2, 'purchase', $3, $4)", [
        row.brand_id,
        decision.amount,
        order.id,
        `ต่ออายุแพ็กเกจ ${row.plan} อัตโนมัติ`
      ]);
      await client.query(
        "update public.brand_plans set plan = $2, valid_until = greatest(valid_until, now()) + interval '30 days' where brand_id = $1",
        [row.brand_id, row.plan]
      );
      await client.query("select public.usage_add($1, 0, 0, $2, 0)", [row.brand_id, PLAN_MESSAGES[row.plan] ?? 0]);
      renewed += 1;
    }
    return { checked: rows.length, renewed, short };
  });
}

/** Would buying `planId` now cut short a dearer plan that is still paid for? */
function downgradeLosesDays(current, planId, now = new Date()) {
  // a plan Kiwmee gave for free (the launch offer) may be replaced by any paid plan
  if (!current || current.effective === "free" || !current.valid_until || current.complimentary) return false;
  if (new Date(current.valid_until) <= now) return false;
  return (PLAN_PRICES[planId] ?? 0) < (PLAN_PRICES[current.effective] ?? 0);
}

/** Buy a package month or an add-on pack from the balance. */
async function buy(brandId, userId, sku) {
  const item = SKUS[sku];
  if (!item) throw badRequest("ไม่พบสินค้านี้");

  return ownerTx(async (client) => {
    await assertOwner(client, brandId, userId);
    if (item.apply === "plan") {
      // A cheaper plan would replace a dearer one that still has paid days left: refuse until the
      // next-cycle downgrade exists (docs/BILLING_PLAN.md 5.3), so a shop never loses days it paid for
      const current = await planOf(client, brandId);
      if (downgradeLosesDays(current, item.plan)) {
        throw new AppError("INVALID", "เปลี่ยนเป็นแพ็กเกจที่ถูกกว่าได้เมื่อแพ็กเกจปัจจุบันหมดอายุ", 422, { reason: "DOWNGRADE_MID_CYCLE" });
      }
    }
    const { rows: [order] } = await client.query(
      "insert into public.wallet_orders (brand_id, sku, amount, created_by) values ($1, $2, $3, $4) returning id",
      [brandId, sku, item.amount, userId]
    );
    let charged;
    try {
      const { rows: [row] } = await client.query("select public.wallet_charge($1, $2, 'purchase', $3, $4) as result", [
        brandId,
        item.amount,
        order.id,
        item.label
      ]);
      charged = Number(row.result.balance);
    } catch (error) {
      if (error.message === "INSUFFICIENT_BALANCE") {
        throw new AppError("INVALID", "ยอดเงินในกระเป๋าไม่พอ — เติมเงินก่อน", 422, { reason: "INSUFFICIENT_BALANCE" });
      }
      throw error;
    }

    if (item.apply === "plan") {
      await client.query(
        `update public.brand_plans
            set plan = $2,
                -- days run on from the current end; a different plan replacing a free (complimentary) one starts now
                valid_until = case when complimentary and plan <> $2 then now() else greatest(coalesce(valid_until, now()), now()) end + interval '30 days',
                complimentary = false
          where brand_id = $1`,
        [brandId, item.plan]
      );
      // the month's message allowance follows the plan (the counter keeps what was granted)
      await client.query("select public.usage_add($1, 0, 0, $2, 0)", [brandId, PLAN_MESSAGES[item.plan] ?? 0]);
    }
    if (item.apply === "messages") {
      await client.query("select public.usage_add($1, 0, 0, 0, $2)", [brandId, item.count]);
    }
    const { rows: [usage] } = await client.query(
      `select messages_used, messages_included, messages_purchased, slips_used from public.usage_counters
        where brand_id = $1 and period = date_trunc('month', (now() at time zone 'Asia/Bangkok'))::date`,
      [brandId]
    );
    return { sku, label: item.label, paid: item.amount, balance: charged, orderId: order.id, usage: usage ?? null };
  });
}

/** Count messages the server sent for a brand (called after a successful push; never throws). */
async function recordMessages(brandId, count = 1) {
  try {
    await getBookingPool().query("select public.usage_add($1, $2)", [brandId, Math.max(1, count)]);
  } catch (error) {
    console.error("[wallet] usage not counted:", error.message);
  }
}

/** Count one automatic slip check for a brand (used by booking deposits as well as top-ups). */
async function recordSlipCheck(brandId) {
  try {
    await getBookingPool().query("select public.usage_add($1, 0, 1)", [brandId]);
  } catch (error) {
    console.error("[wallet] slip usage not counted:", error.message);
  }
}

/** A brand at 100% of its month's messages may not send more cards; bookings and bills still work. */
function messageAllowed(quota) {
  return !quota || quota.level !== "full";
}

/**
 * What a shop's brand may still send this month: { brandId, quota, allowed }. A shop that has run out
 * keeps taking bookings — only the LINE cards stop (the customer still has the page and the link).
 */
async function allowanceForBusiness(db, businessId) {
  try {
    const { rows: [row] } = await db.query(
      `select b.brand_id, public.brand_plan(b.brand_id) as plan,
              coalesce(u.messages_used, 0) as used,
              coalesce(u.messages_included, 0) as included,
              coalesce(u.messages_purchased, 0) as purchased
         from public.businesses b
         left join public.usage_counters u
                on u.brand_id = b.brand_id
               and u.period = date_trunc('month', (now() at time zone 'Asia/Bangkok'))::date
        where b.id = $1`,
      [businessId]
    );
    if (!row?.brand_id) return null;
    const quota = quotaOf(row.plan, { messagesUsed: row.used, messagesIncluded: row.included, messagesPurchased: row.purchased });
    return { brandId: row.brand_id, quota, allowed: messageAllowed(quota) };
  } catch (error) {
    // never stop a card because the counter could not be read
    console.error("[wallet] quota not read:", error.message);
    return null;
  }
}

/** One LINE push went out for a shop: count it on the brand's month. Never throws. */
async function meterMessage(db, businessId, count = 1) {
  try {
    const { rows } = await db.query("select brand_id from public.businesses where id = $1", [businessId]);
    const brand = rows[0]?.brand_id;
    if (brand) await db.query("select public.usage_add($1, $2)", [brand, Math.max(1, count)]);
  } catch (error) {
    console.error("[wallet] message not counted:", error.message);
  }
}

/**
 * The slips waiting for a human (plus the last few that were decided), for /super.
 * Reads across brands, so it runs on the server's own connection after proving the caller is a
 * platform admin — the wallet tables' RLS only shows a brand's own rows.
 */
async function listTopups(userId, { limit = 40 } = {}) {
  return ownerTx(async (client) => {
    await requirePlatformAdminId(client, userId);
    const { rows } = await client.query(
      `select t.id, t.amount::float8 as amount, t.status, t.check_status, t.check_reasons,
              t.credit_amount::float8 as credit_amount, t.trans_ref, t.receiver_text,
              t.created_at, t.credited_at, t.reviewed_by, b.id as brand_id, b.name as brand_name,
              (select count(*)::int from public.wallet_topups p where p.status = 'pending') as pending_count
         from public.wallet_topups t join public.brands b on b.id = t.brand_id
        order by (t.status = 'pending') desc, t.created_at desc
        limit $1`,
      [Math.min(Math.max(Number(limit) || 40, 1), 200)]
    );
    return { topups: rows, pending: rows[0]?.pending_count ?? 0 };
  });
}

/** Approve (credit the wallet) or reject one slip. Only a platform admin can do this. */
async function reviewTopup(adminUserId, topupId, action) {
  if (action !== "approve" && action !== "reject") throw badRequest("คำสั่งไม่ถูกต้อง");
  return ownerTx(async (client) => {
    await requirePlatformAdminId(client, adminUserId);
    const { rows: [topup] } = await client.query("select * from public.wallet_topups where id = $1 for update", [topupId]);
    if (!topup) throw notFound("ไม่พบรายการเติมเงินนี้");

    if (action === "reject") {
      if (topup.status === "credited") throw badRequest("รายการนี้เติมเงินไปแล้ว ย้อนกลับไม่ได้");
      const { rows: [row] } = await client.query(
        "update public.wallet_topups set status = 'rejected', reviewed_by = $2 where id = $1 returning status",
        [topupId, adminUserId]
      );
      return { id: topupId, status: row.status };
    }

    if (topup.status === "credited") {
      const { rows: [account] } = await client.query("select balance::float8 as balance from public.wallet_accounts where brand_id = $1", [topup.brand_id]);
      return { id: topupId, status: "credited", balance: account?.balance ?? 0, already: true };
    }
    if (topup.status !== "pending") throw badRequest("รายการนี้ปิดแล้ว");

    const { rows: [credited] } = await client.query("select public.wallet_apply_topup($1, $2, $3, $4) as result", [
      topupId,
      topup.amount,
      topup.trans_ref,
      topup.receiver_text
    ]);
    await client.query("update public.wallet_topups set reviewed_by = $2 where id = $1", [topupId, adminUserId]);
    return { id: topupId, status: "credited", credited: Number(topup.amount), balance: Number(credited.result.balance) };
  });
}

module.exports = { ownerTx, topupQr, brandCounts, downgradeLosesDays, SKUS, PLAN_MESSAGES, PLAN_PRICES, renewalDecision, renewDuePlans, quotaOf, messageAllowed, allowanceForBusiness, walletOf, submitTopup, buy, judgeTopup, recordMessages, recordSlipCheck, meterMessage, listTopups, reviewTopup, MIN_TOPUP, MAX_TOPUP };
