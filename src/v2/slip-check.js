// Transfer slips checked automatically (migration …003300): v1's slip checking (src/payment/*) moved
// to v2 in a small form. The bank-slip reading service (EasySlip v2, key in /super) reads the slip;
// we then check it against the booking: enough money, to this shop's account, not before the booking
// was made, and not a transfer that already paid for something else.
//
// The reading service is a helper, not the bank (v1 kept it "not authoritative" too): by default the
// shop still confirms; a shop may switch on slip_auto_confirm to let a slip that passes every check
// confirm the deposit itself. With no key set nothing is checked and everything works as before.

const { getSetting } = require("./platform-settings");

const ENDPOINT = "https://api.easyslip.com/v2/verify/bank";
const EARLY_MINUTES = 10; // bank and server clocks differ a little

const REASON_TEXT = {
  AMOUNT_LOW: "ยอดในสลิปน้อยกว่ามัดจำ",
  RECEIVER_MISMATCH: "บัญชีผู้รับไม่ตรงกับบัญชีร้าน",
  RECEIVER_UNKNOWN: "ตรวจบัญชีผู้รับไม่ได้",
  TOO_EARLY: "โอนก่อนจองคิวนี้",
  DUPLICATE: "สลิปนี้เคยใช้แล้ว",
  UNREADABLE: "อ่านสลิปไม่ได้"
};

const digits = (v) => String(v ?? "").replace(/[^0-9]/g, "");

/**
 * Does a masked number from a slip ("xxx-x-x1234-x", "xxx-xxx-5678") fit the shop's number?
 * Every digit shown must be where the shop's number has it; at least 3 must show.
 * null = nothing to compare.
 */
function maskedMatches(masked, full) {
  const pattern = String(masked ?? "").replace(/[^0-9xX*]/g, "").toLowerCase().replace(/\*/g, "x");
  const number = digits(full);
  if (!pattern || !number) return null;
  const shown = pattern.replace(/x/g, "").length;
  if (shown < 3) return null;
  if (pattern.length === number.length) return [...pattern].every((c, i) => c === "x" || c === number[i]);
  // different lengths (a phone as 0812… vs 66812…): the digits shown at the end must match its end
  const tail = pattern.match(/[0-9]+x*$/)?.[0]?.replace(/x+$/, "") ?? "";
  if (tail.length < 3) return null;
  const trailingMask = pattern.length - pattern.lastIndexOf(tail) - tail.length;
  return number.slice(0, number.length - trailingMask).endsWith(tail);
}

/** The shop's account (payment_info) against the slip's receiver: "match" · "mismatch" · "unknown" */
function receiverMatch(paymentInfo = {}, receiver = {}) {
  const tries = [];
  if (paymentInfo.promptPay && receiver.proxy) tries.push(maskedMatches(receiver.proxy, normalPromptPay(paymentInfo.promptPay)) ?? maskedMatches(receiver.proxy, paymentInfo.promptPay));
  if (paymentInfo.accountNumber && receiver.account) tries.push(maskedMatches(receiver.account, paymentInfo.accountNumber));
  if (tries.includes(true)) return "match";
  if (tries.includes(false)) return "mismatch";
  return "unknown"; // a name alone is not enough
}

// PromptPay phones appear on slips as 66… or 0…; keep the shop's as given and let the tail decide
const normalPromptPay = (v) => digits(v);

/** EasySlip's answer → { ok, transRef, amount, paidAt, receiver: { name, account, proxy }, duplicate, error } */
function readEasySlip(body, httpStatus) {
  const data = body?.data ?? {};
  if (httpStatus < 200 || httpStatus >= 300 || body?.status === "error" || body?.code) {
    return { ok: false, error: String(body?.code ?? data?.code ?? `HTTP_${httpStatus}`).slice(0, 40) };
  }
  const slip = data.rawSlip ?? {};
  const amount = Number(slip.amount?.amount ?? body?.amountInSlip ?? NaN);
  return {
    ok: true,
    transRef: slip.transRef ? String(slip.transRef).trim() : null,
    amount: Number.isFinite(amount) ? amount : null,
    paidAt: slip.date ? new Date(slip.date).toISOString() : null,
    duplicate: Boolean(data.isDuplicate),
    receiver: {
      name: slip.receiver?.account?.name?.th ?? slip.receiver?.account?.name?.en ?? null,
      account: slip.receiver?.account?.bank?.account ?? null,
      proxy: slip.receiver?.account?.proxy?.account ?? null
    }
  };
}

/** Ask the reading service about one slip (a JPEG). null when no key is set. */
async function readSlip(db, jpeg, { env = process.env, fetchImpl = fetch } = {}) {
  const key = await getSetting(db, "slip.easyslip_api_key", { env });
  if (!key) return null;
  try {
    const response = await fetchImpl(ENDPOINT, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ base64: `data:image/jpeg;base64,${Buffer.from(jpeg).toString("base64")}`, checkDuplicate: true }),
      signal: AbortSignal.timeout(10000)
    });
    const body = await response.json().catch(() => ({}));
    return readEasySlip(body, response.status);
  } catch (error) {
    return { ok: false, error: error.name === "TimeoutError" ? "TIMEOUT" : "UNAVAILABLE" };
  }
}

/** What the slip says against the booking: { status: passed | failed | error, reasons: [...] } */
function judge(read, { depositDue, bookedAt, paymentInfo }) {
  if (!read.ok) return { status: "error", reasons: [] };
  const reasons = [];
  if (!read.transRef || read.amount === null) reasons.push("UNREADABLE");
  if (read.amount !== null && Math.round(read.amount * 100) < Math.round(Number(depositDue ?? 0) * 100)) reasons.push("AMOUNT_LOW");
  const receiver = receiverMatch(paymentInfo, read.receiver);
  if (receiver === "mismatch") reasons.push("RECEIVER_MISMATCH");
  if (receiver === "unknown") reasons.push("RECEIVER_UNKNOWN");
  if (read.paidAt && bookedAt && new Date(read.paidAt).getTime() < new Date(bookedAt).getTime() - EARLY_MINUTES * 60000) reasons.push("TOO_EARLY");
  if (read.duplicate) reasons.push("DUPLICATE");
  return { status: reasons.length ? "failed" : "passed", reasons };
}

/**
 * After a customer sent a slip (the server's connection): read it, record the result, and — if the
 * shop allows it and every check passed — confirm the deposit. Never throws: the slip is already in.
 * Returns { status, reasons, confirmed } or null (no key: not checked).
 */
async function checkSlip(db, slipId, jpeg, { env = process.env, fetchImpl = fetch, onConfirmed = null } = {}) {
  try {
    // the brand's automatic checks this month: its plan's allowance plus packs bought (migration …004100)
    const quota = await slipQuota(db, slipId);
    if (quota && !quota.allowed) return null; // used up: the shop checks this slip by eye, as before
    const read = await readSlip(db, jpeg, { env, fetchImpl });
    if (!read) return null;
    if (quota?.brandId) await db.query("select public.usage_add($1, 0, 1)", [quota.brandId]).catch(() => {});
    const { rows: [s] } = await db.query(
      `select s.booking_id, b.business_id, b.deposit_due, b.created_at, b.status, st.payment_info, coalesce(st.slip_auto_confirm, false) as auto
         from public.payment_slips s join public.bookings b on b.id = s.booking_id
         left join public.business_booking_settings st on st.business_id = b.business_id
        where s.id = $1`,
      [slipId]
    );
    if (!s) return null;
    const verdict = judge(read, { depositDue: s.deposit_due, bookedAt: s.created_at, paymentInfo: s.payment_info ?? {} });
    const receiverText = [read.receiver?.name, read.receiver?.proxy ?? read.receiver?.account].filter(Boolean).join(" · ") || null;
    const { rows: [r] } = await db.query("select public.slip_record_check($1, $2, $3, $4, $5, $6, $7) as status", [
      slipId,
      verdict.status,
      verdict.reasons,
      read.ok ? read.transRef : null,
      read.ok ? read.amount : null,
      read.ok ? read.paidAt : null,
      receiverText
    ]);
    const status = r.status;
    let confirmed = false;
    if (status === "passed" && s.auto && ["held", "pending"].includes(s.status)) {
      await db.query("select public.confirm_deposit($1, $2, 'transfer')", [s.booking_id, s.deposit_due]);
      confirmed = true;
      if (onConfirmed) await onConfirmed(s.booking_id, s.business_id).catch(() => {});
    }
    const { rows: [after] } = await db.query("select check_reasons from public.payment_slips where id = $1", [slipId]);
    return { status, reasons: after.check_reasons, confirmed };
  } catch (error) {
    console.error("[slip-check] failed:", error.message);
    return { status: "error", reasons: [], confirmed: false };
  }
}

/** May this slip's brand still use an automatic check this month? null when it cannot be read (then check) */
async function slipQuota(db, slipId) {
  try {
    const { rows: [q] } = await db.query(
      `select b.brand_id,
              public.plan_limit(public.brand_plan(b.brand_id), 'slip_checks') as included,
              coalesce((select u.slips_used from public.usage_counters u
                         where u.brand_id = b.brand_id
                           and u.period = date_trunc('month', (now() at time zone 'Asia/Bangkok'))::date), 0) as used,
              (select count(*)::int * 100 from public.wallet_orders o
                where o.brand_id = b.brand_id and o.sku = 'slip:100' and o.status = 'paid'
                  and o.created_at >= date_trunc('month', now() at time zone 'Asia/Bangkok') at time zone 'Asia/Bangkok') as purchased
         from public.payment_slips s
         join public.bookings k on k.id = s.booking_id
         join public.businesses b on b.id = k.business_id
        where s.id = $1`,
      [slipId]
    );
    if (!q) return null;
    const allowed = q.included === null || q.used < q.included + q.purchased;
    return { brandId: q.brand_id, allowed };
  } catch (error) {
    console.error("[slip-check] quota not read:", error.message);
    return null;
  }
}

module.exports = { slipQuota, checkSlip, judge, readSlip, readEasySlip, receiverMatch, maskedMatches, REASON_TEXT };
