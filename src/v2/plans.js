// แพ็กเกจของ Kiwmee — ตารางเดียวที่โค้ดและหน้าจอใช้ร่วมกัน (docs/BILLING_PLAN.md ข้อ 2)
//
// ราคา โควตา และฟีเจอร์ของแต่ละแพ็กเกจอยู่ที่นี่ที่เดียว: กระเป๋าเงินคิดราคาจากตารางนี้ หน้า
// "แพ็กเกจและการชำระเงิน" แสดงตารางเทียบจากตารางนี้ และรายงานรายได้คิด MRR จากตารางนี้
// เพดาน (limits) และฟีเจอร์ (features) ยังไม่ถูกบังคับในฐานข้อมูลจนกว่าจะถึง PR B3
// (ตอนนี้ฐานข้อมูลบังคับแค่จำนวนสาขาผ่าน brand_branch_limit()) — ตัวเลขที่นี่คือสิ่งที่จะบังคับ

const UNLIMITED = null;

const PLANS = [
  {
    id: "free",
    name: "ฟรี",
    tagline: "ลองใช้ หรือร้านคนเดียว",
    monthly: 0,
    yearly: 0,
    limits: { bookingsPerMonth: 50, resources: 2, members: 1, branches: 1, messages: 100, slipChecks: 0 },
    features: { reminders: false, addons: false, rentals: false, layout: false, loyalty: false, export: false, onlineBooking: true }
  },
  {
    id: "starter",
    name: "เริ่มต้น",
    tagline: "ร้านเล็ก 1 สาขา อยากลดลูกค้าไม่มาตามนัด",
    monthly: 390,
    yearly: 3900,
    limits: { bookingsPerMonth: UNLIMITED, resources: 5, members: 3, branches: 1, messages: 900, slipChecks: 50 },
    features: { reminders: true, addons: true, rentals: false, layout: false, loyalty: false, export: false, onlineBooking: true }
  },
  {
    id: "pro",
    name: "โปร",
    tagline: "ให้ลูกค้ากลับมาซ้ำด้วยระบบสมาชิก รองรับหลายสาขา",
    monthly: 890,
    yearly: 8900,
    recommended: true,
    limits: { bookingsPerMonth: UNLIMITED, resources: UNLIMITED, members: UNLIMITED, branches: 2, messages: 4000, slipChecks: 300 },
    features: { reminders: true, addons: true, rentals: true, layout: true, loyalty: true, export: true, onlineBooking: true }
  },
  {
    id: "loyalty",
    name: "สมาชิก",
    tagline: "มีระบบจองอยู่แล้ว อยากได้บัตรสมาชิกและคะแนน",
    monthly: 590,
    yearly: 5900,
    limits: { bookingsPerMonth: 0, resources: UNLIMITED, members: 3, branches: 2, messages: 1200, slipChecks: 0 },
    features: { reminders: false, addons: false, rentals: false, layout: false, loyalty: true, export: true, onlineBooking: false }
  }
];

// แถวของตารางเทียบแพ็กเกจ (ลำดับตามที่แสดง)
const LIMIT_ROWS = [
  { key: "bookingsPerMonth", label: "การจองออนไลน์ต่อเดือน", unit: "ครั้ง" },
  { key: "resources", label: "ช่าง / สนาม / ห้อง", unit: "" },
  { key: "members", label: "บัญชีพนักงาน (รวมเจ้าของ)", unit: "คน" },
  { key: "branches", label: "สาขาในแพ็กเกจ", unit: "สาขา" },
  { key: "messages", label: "ข้อความ LINE ต่อเดือน", unit: "ข้อความ" },
  { key: "slipChecks", label: "ตรวจสลิปอัตโนมัติต่อเดือน", unit: "ครั้ง" }
];
const FEATURE_ROWS = [
  { key: "reminders", label: "การ์ด LINE เตือนนัด" },
  { key: "addons", label: "ตัวเลือกเสริม (เช่าไม้ ทรีตเมนต์เพิ่ม)" },
  { key: "rentals", label: "เช่ารายวัน + เอกสารประกอบการเช่า" },
  { key: "layout", label: "แผนผังสนาม" },
  { key: "loyalty", label: "ระบบสมาชิก: คะแนน รางวัล ระดับ บัตร" },
  { key: "export", label: "ส่งออกรายงาน CSV" }
];
// ทุกแพ็กเกจได้
const EVERY_PLAN = ["บิล / รายรับ / สแกน QR", "ปฏิทินการจอง", "มัดจำโอนเงิน (ร้านยืนยันเอง)", "การ์ด LINE ยืนยันการจอง"];

// แพ็กเสริมที่ซื้อจากกระเป๋าได้ตอนนี้ (สาขาเพิ่ม / SMS / ตั้งค่าร้านให้ มาใน B6)
const ADDONS = [
  { sku: "msg:500", amount: 99, label: "ข้อความ LINE เพิ่ม 500", short: "+500 ข้อความ", apply: "messages", count: 500, group: "messages" },
  { sku: "msg:1500", amount: 249, label: "ข้อความ LINE เพิ่ม 1,500", short: "+1,500 ข้อความ", apply: "messages", count: 1500, group: "messages" },
  { sku: "msg:5000", amount: 699, label: "ข้อความ LINE เพิ่ม 5,000", short: "+5,000 ข้อความ", apply: "messages", count: 5000, group: "messages" },
  { sku: "slip:100", amount: 59, label: "ตรวจสลิปเพิ่ม 100 ครั้ง", short: "+100 ครั้ง", apply: "slips", count: 100, group: "slips" }
];

const planById = (id) => PLANS.find((p) => p.id === id) ?? PLANS[0];

// What the shop reads when the database refuses something its plan does not include
// (migration …004100 raises BK422 with these messages)
const PLAN_REASON_TEXT = {
  PLAN_RESOURCES: "แพ็กเกจของคุณเปิดช่าง/สนาม/ห้องได้เต็มจำนวนแล้ว · ปิดตัวที่ไม่ใช้ หรืออัปเกรดแพ็กเกจ",
  PLAN_MEMBERS: "แพ็กเกจของคุณมีบัญชีพนักงานครบจำนวนแล้ว · อัปเกรดแพ็กเกจเพื่อเพิ่มคน",
  PLAN_FEATURE_LAYOUT: "แผนผังสนามใช้ได้ในแพ็กเกจโปร",
  PLAN_FEATURE_ADDONS: "ตัวเลือกเสริมใช้ได้ตั้งแต่แพ็กเกจเริ่มต้น",
  PLAN_FEATURE_RENTALS: "การเช่ารายวันใช้ได้ในแพ็กเกจโปร",
  PLAN_FEATURE_LOYALTY: "ระบบสมาชิกและคะแนนใช้ได้ในแพ็กเกจโปรหรือแพ็กเกจสมาชิก",
  PLAN_BOOKINGS_FULL: "ร้านรับจองออนไลน์ครบจำนวนของเดือนนี้แล้ว กรุณาติดต่อร้านโดยตรง",
  PLAN_ONLINE_OFF: "ร้านนี้ไม่ได้เปิดรับจองออนไลน์ กรุณาติดต่อร้านโดยตรง",
  PLAN_LIMIT: "แพ็กเกจของแบรนด์นี้มีสาขาครบจำนวนแล้ว · อัปเกรดแพ็กเกจเพื่อเพิ่มสาขา"
};

/** A refusal from the plan guards as the shop should read it, or null for any other error */
function planRefusal(error, AppError) {
  if (error?.code !== "BK422" || !PLAN_REASON_TEXT[error.message] || !error.message.startsWith("PLAN_")) return null;
  return new AppError("PLAN_LIMIT", PLAN_REASON_TEXT[error.message], 422, { reason: error.message });
}

/** Everything the wallet can sell, by SKU: one month of each paid plan, then the add-on packs. */
function buildSkus() {
  const skus = {};
  for (const p of PLANS) {
    if (p.monthly > 0) skus[`plan:${p.id}`] = { amount: p.monthly, label: `แพ็กเกจ${p.name} 1 เดือน`, apply: "plan", plan: p.id, cycle: "month" };
    if (p.yearly > 0) skus[`plan:${p.id}:year`] = { amount: p.yearly, label: `แพ็กเกจ${p.name} 1 ปี`, apply: "plan", plan: p.id, cycle: "year" };
  }
  for (const a of ADDONS) skus[a.sku] = { amount: a.amount, label: a.label, apply: a.apply, count: a.count };
  return skus;
}

const PLAN_PRICES = Object.fromEntries(PLANS.map((p) => [p.id, p.monthly]));
const PLAN_MESSAGES = Object.fromEntries(PLANS.map((p) => [p.id, p.limits.messages]));

/** The catalog the billing page shows (plain data, safe to send to the browser). */
function planCatalog() {
  return {
    plans: PLANS.map((p) => ({ ...p, limits: { ...p.limits }, features: { ...p.features } })),
    limitRows: LIMIT_ROWS,
    featureRows: FEATURE_ROWS,
    everyPlan: EVERY_PLAN,
    addons: ADDONS.map((a) => ({ ...a }))
  };
}


// ---------- buying, renewing and changing a plan (B4, docs/BILLING_PLAN.md 5) ----------

const DAY_MS = 24 * 3600 * 1000;
const PERIOD_DAYS = { month: 30, year: 365 };
const RENEW_WITHIN_DAYS = 3;
const GRACE_DAYS = 7;
const TRIAL_DAYS = 14;
const addDays = (date, days) => new Date(new Date(date).getTime() + days * DAY_MS);

/** Price of one period of a plan: monthly, or a year (= ten months) */
function priceOf(planId, cycle = "month") {
  const plan = planById(planId);
  return cycle === "year" ? plan.yearly : plan.monthly;
}

/** The paid plan running now, or null (free, ended, or a plan Kiwmee gave: trial / launch offer) */
function runningPaid(current, now) {
  if (!current || current.effective === "free" || current.complimentary || !current.valid_until) return null;
  return new Date(current.valid_until) > now ? current : null;
}

/**
 * What buying `planId` for a `cycle` does today: { mode, amount, validUntil, cycle }.
 *   new        nothing paid is running: full price, from today
 *   after_free the plan Kiwmee gave is the same plan: full price, days run on after the free ones
 *   renew      the same plan and cycle: full price, one more period after the current end
 *   upgrade    a dearer plan, same cycle: pay the difference for the days left, same end date
 *   switch     a longer cycle (month → year), same or dearer plan: a new period from today,
 *              minus what is left of the current one
 *   schedule   cheaper, or a shorter cycle: nothing now, it starts at the next renewal
 * `current` = brand_plans row: { effective, valid_until, cycle, complimentary }.
 */
function quotePlan(current, planId, cycle = "month", now = new Date()) {
  const price = priceOf(planId, cycle);
  const days = PERIOD_DAYS[cycle];
  const paid = runningPaid(current, now);
  if (!paid) {
    const gift = current?.complimentary && current.effective === planId && current.valid_until && new Date(current.valid_until) > now;
    return { mode: gift ? "after_free" : "new", amount: price, validUntil: addDays(gift ? current.valid_until : now, days), cycle };
  }
  const from = planById(paid.effective);
  const to = planById(planId);
  const fromCycle = paid.cycle === "year" ? "year" : "month";
  const fromPrice = priceOf(from.id, fromCycle);
  const fromDays = PERIOD_DAYS[fromCycle];
  const left = Math.min(fromDays, Math.max(0, (new Date(paid.valid_until) - now) / DAY_MS));
  if (to.id === from.id && cycle === fromCycle) {
    return { mode: "renew", amount: price, validUntil: addDays(paid.valid_until, days), cycle };
  }
  if (cycle === fromCycle && to.monthly > from.monthly) {
    return { mode: "upgrade", amount: Math.ceil(((price - fromPrice) * left) / fromDays), validUntil: new Date(paid.valid_until), cycle };
  }
  if (cycle === "year" && fromCycle === "month" && to.monthly >= from.monthly) {
    const credit = (fromPrice * left) / fromDays;
    return { mode: "switch", amount: Math.max(0, Math.ceil(price - credit)), validUntil: addDays(now, days), cycle };
  }
  return { mode: "schedule", amount: 0, validUntil: new Date(paid.valid_until), cycle };
}

/**
 * What the hourly renewal does for one brand: { action, amount, plan, cycle }
 *   renew  within 3 days of the end (or in grace) and the wallet pays: next period after the end
 *   short  the wallet cannot pay yet (it is tried again every hour)
 *   grace  the end has passed and the wallet could not pay: 7 more days start now
 *   end    auto-renew is off / the next plan is free: nothing is charged, the plan just ends
 *   none   not due, a free plan, or a plan Kiwmee gave (trial / launch offer)
 */
function renewalDecision(row, now = new Date()) {
  const none = { action: "none", amount: 0, plan: row.plan, cycle: row.cycle ?? "month" };
  if (!row.plan || row.plan === "free" || row.complimentary || !row.validUntil) return none;
  const end = new Date(row.validUntil);
  const graceUntil = row.graceUntil ? new Date(row.graceUntil) : null;
  if (end - now > RENEW_WITHIN_DAYS * DAY_MS) return none;
  if (end <= now && graceUntil && graceUntil <= now) return none; // grace is over: the plan is free now
  if (row.autoRenew === false || row.nextPlan === "free") return { ...none, action: "end" };
  const plan = row.nextPlan ?? row.plan;
  const cycle = row.nextCycle ?? row.cycle ?? "month";
  const amount = priceOf(plan, cycle);
  if ((Number(row.balance) || 0) >= amount) return { action: "renew", amount, plan, cycle };
  if (end <= now && !graceUntil) return { action: "grace", amount, plan, cycle, graceUntil: addDays(end, GRACE_DAYS) };
  return { action: "short", amount, plan, cycle };
}

module.exports = { PERIOD_DAYS, RENEW_WITHIN_DAYS, GRACE_DAYS, TRIAL_DAYS, priceOf, quotePlan, renewalDecision, PLAN_REASON_TEXT, planRefusal, PLANS, ADDONS, LIMIT_ROWS, FEATURE_ROWS, EVERY_PLAN, UNLIMITED, planById, buildSkus, planCatalog, PLAN_PRICES, PLAN_MESSAGES };
