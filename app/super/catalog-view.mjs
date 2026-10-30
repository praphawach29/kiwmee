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

export function filterBrands(brands = [], { query = "", plan = "" } = {}) {
  return brands.filter((brand) => (!plan || brand.plan === plan) && matches(query, [brand.name, brand.ownerEmail, brand.id, brand.plan, planName(brand.plan)]));
}
