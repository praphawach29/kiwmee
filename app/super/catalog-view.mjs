export const PLAN_NAMES = { free: "ฟรี", starter: "เริ่มต้น", pro: "โปร", loyalty: "สมาชิก" };
export const KIND_NAMES = { salon: "ร้านเสริมสวย", barber: "ร้านตัดผมชาย", spa: "สปา / นวด", court: "สนามกีฬา", other: "อื่น ๆ" };
export const bookingPath = (slug) => slug ? `/b/${encodeURIComponent(slug)}` : null;
export const planName = (value) => PLAN_NAMES[value] ?? value ?? "ไม่ระบุ";
export const kindName = (value) => KIND_NAMES[value] ?? value ?? "ไม่ระบุ";
const normalize = (value) => String(value ?? "").trim().toLocaleLowerCase("th");
const matches = (query, fields) => fields.some((value) => normalize(value).includes(normalize(query)));

export function filterShops(shops = [], { query = "", kind = "", brandId = "" } = {}) {
  return shops.filter((shop) => (!kind || shop.kind === kind)
    && (!brandId || (brandId === "unassigned" ? !shop.brandId : shop.brandId === brandId))
    && matches(query, [shop.name, shop.slug, shop.brandName, shop.id, shop.kind, kindName(shop.kind)]));
}

const DAY = 864e5;
const thDate = (value) => new Date(value).toLocaleDateString("th-TH", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Bangkok" });

/** Where a brand's plan stands today: { key, label, tone } for a chip and the status filter */
export function brandStatus(brand, now = new Date()) {
  const until = brand?.validUntil ? new Date(brand.validUntil) : null;
  const grace = brand?.graceUntil ? new Date(brand.graceUntil) : null;
  if (until && until <= now && grace && grace > now) return { key: "grace", label: `ผ่อนผันถึง ${thDate(grace)}`, tone: "warn" };
  if (!brand || brand.plan === "free") return { key: "free", label: "ฟรี", tone: "" };
  if (!until) return { key: "forever", label: "ไม่หมดอายุ", tone: "info" };
  if (brand.trial) return { key: "trial", label: `ทดลองถึง ${thDate(until)}`, tone: "info" };
  if (brand.complimentary) return { key: "gift", label: `ใช้ฟรีถึง ${thDate(until)}`, tone: "info" };
  const days = Math.ceil((until - now) / DAY);
  if (days <= 7) return { key: "expiring", label: `หมดใน ${days} วัน`, tone: "warn" };
  return { key: "paid", label: `ถึง ${thDate(until)}`, tone: "ok" };
}
export const STATUS_NAMES = { paid: "จ่ายเงินอยู่", expiring: "ใกล้หมดอายุ (7 วัน)", grace: "ช่วงผ่อนผัน", trial: "ทดลองใช้", gift: "ใช้ฟรี (ข้อเสนอ)", forever: "ไม่หมดอายุ", free: "ฟรี" };

export function filterBrands(brands = [], { query = "", plan = "", status = "", now = new Date() } = {}) {
  return brands.filter((brand) => (!plan || brand.plan === plan)
    && (!status || brandStatus(brand, now).key === status)
    && matches(query, [brand.name, brand.ownerEmail, brand.id, brand.plan, planName(brand.plan)]));
}
