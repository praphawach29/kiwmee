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
const { getSetting } = require("./platform-settings");
const { readSlip, receiverMatch } = require("./slip-check");

const DAY = 24 * 3600 * 1000;
const MIN_TOPUP = 100;
const MAX_TOPUP = 20000;
const SLIP_MAX_BYTES = 1_500_000;
const TOPUP_WINDOW_DAYS = 7;

// What can be bought from the balance. `apply` says what the purchase changes.
const SKUS = {
  "plan:starter": { amount: 390, label: "แพ็กเกจเริ่มต้น 1 เดือน", apply: "plan", plan: "starter" },
  "plan:pro": { amount: 890, label: "แพ็กเกจโปร 1 เดือน", apply: "plan", plan: "pro" },
  "plan:loyalty": { amount: 590, label: "แพ็กเกจสมาชิก 1 เดือน", apply: "plan", plan: "loyalty" },
  "msg:500": { amount: 99, label: "ข้อความ LINE เพิ่ม 500", apply: "messages", count: 500 },
  "msg:1500": { amount: 249, label: "ข้อความ LINE เพิ่ม 1,500", apply: "messages", count: 1500 },
  "msg:5000": { amount: 699, label: "ข้อความ LINE เพิ่ม 5,000", apply: "messages", count: 5000 },
  "slip:100": { amount: 59, label: "ตรวจสลิปเพิ่ม 100 ครั้ง", apply: "slips", count: 100 }
};

const imageError = (message) => new AppError("INVALID", message, 422);

// How many LINE messages each package includes per month (docs/WALLET.md). The counter table keeps
// what was actually granted; this is the fallback for brands whose plan was set before …003700.
const PLAN_MESSAGES = { free: 100, starter: 900, pro: 4000, loyalty: 1200 };

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
            public.brand_plan(p.brand_id) as effective
       from public.brand_plans p where p.brand_id = $1`,
    [brandId]
  );
  return row ?? { plan: "free", valid_until: null, expired: false, effective: "free" };
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
    return {
      balance: account?.balance ?? 0,
      plan,
      usage,
      quota: quotaOf(plan.effective, usage),
      entries,
      topups,
      orders,
      packs: Object.entries(SKUS).map(([sku, s]) => ({ sku, ...s })),
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

/** Buy a package month or an add-on pack from the balance. */
async function buy(brandId, userId, sku) {
  const item = SKUS[sku];
  if (!item) throw badRequest("ไม่พบสินค้านี้");

  return ownerTx(async (client) => {
    await assertOwner(client, brandId, userId);
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
                valid_until = greatest(coalesce(valid_until, now()), now()) + interval '30 days'
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

module.exports = { SKUS, walletOf, submitTopup, buy, judgeTopup, recordMessages, recordSlipCheck, meterMessage, MIN_TOPUP, MAX_TOPUP };
