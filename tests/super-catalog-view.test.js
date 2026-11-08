const test = require("node:test");
const assert = require("node:assert/strict");
const helpers = import("../app/super/catalog-view.mjs");

test("brand search combines trimmed case-insensitive owner/name matching with exact plan", async () => {
  const { filterBrands } = await helpers;
  const brands = [{ id: "a", name: "Bloom", ownerEmail: "OWNER@example.com", plan: "pro" }, { id: "b", name: "Bloom Free", plan: "free" }];
  assert.deepEqual(filterBrands(brands, { query: "  OwNeR  ", plan: "pro" }), [brands[0]]);
  assert.deepEqual(filterBrands(brands, { query: "Bloom", plan: "free" }), [brands[1]]);
  assert.deepEqual(filterBrands(brands, { query: "missing" }), []);
  assert.equal(brands.length, 2);
});

test("shop filters intersect name/slug/brand search, kind and brand ID (not duplicate brand names)", async () => {
  const { filterShops } = await helpers;
  const shops = [
    { id: "s1", name: "สาขาสยาม", slug: "Bloom-Siam", kind: "salon", brandName: "Bloom", brandId: "a" },
    { id: "s2", name: "ร้านสอง", slug: "second", kind: "barber", brandName: "Bloom", brandId: "b" },
    { id: "s3", name: "ร้านอิสระ", slug: "solo", kind: null, brandId: null },
  ];
  assert.deepEqual(filterShops(shops, { query: " bloom ", kind: "salon", brandId: "a" }), [shops[0]]);
  assert.deepEqual(filterShops(shops, { query: "SIAM" }), [shops[0]]);
  assert.deepEqual(filterShops(shops, { query: "สยาม" }), [shops[0]]);
  assert.deepEqual(filterShops(shops, { brandId: "a", kind: "barber" }), []);
  assert.deepEqual(filterShops(shops, { brandId: "unassigned" }), [shops[2]]);
  assert.deepEqual(filterShops(), []);
});

test("Thai labels preserve unknown values and booking paths only encode the actual slug", async () => {
  const { planName, kindName, bookingPath } = await helpers;
  assert.equal(planName("loyalty"), "สมาชิก");
  assert.equal(kindName("court"), "สนามกีฬา");
  assert.equal(planName("future"), "future");
  assert.equal(kindName(null), "ไม่ระบุ");
  assert.equal(bookingPath("bloom-siam"), "/b/bloom-siam");
  assert.equal(bookingPath("shop?token=secret"), "/b/shop%3Ftoken%3Dsecret");
  assert.equal(bookingPath(null), null);
});

test("brand status: grace, trial, free gift, expiring, paid, no end date, free", async () => {
  const { brandStatus, filterBrands } = await import("../app/super/catalog-view.mjs");
  const now = new Date("2026-11-08T00:00:00Z");
  const day = (n) => new Date(now.getTime() + n * 864e5).toISOString();
  assert.equal(brandStatus({ plan: "starter", validUntil: day(-1), graceUntil: day(6) }, now).key, "grace");
  assert.equal(brandStatus({ plan: "pro", validUntil: day(9), trial: true, complimentary: true }, now).key, "trial");
  assert.equal(brandStatus({ plan: "pro", validUntil: day(80), complimentary: true }, now).key, "gift");
  assert.deepEqual(brandStatus({ plan: "pro", validUntil: day(5) }, now), { key: "expiring", label: "หมดใน 5 วัน", tone: "warn" });
  assert.equal(brandStatus({ plan: "pro", validUntil: day(25) }, now).key, "paid");
  assert.equal(brandStatus({ plan: "pro", validUntil: null }, now).key, "forever");
  assert.equal(brandStatus({ plan: "free" }, now).key, "free");
  const brands = [{ id: "a", name: "A", plan: "pro", validUntil: day(5) }, { id: "b", name: "B", plan: "pro", validUntil: day(25) }];
  assert.deepEqual(filterBrands(brands, { status: "expiring", now }).map((b) => b.id), ["a"]);
});
