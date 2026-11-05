const test = require("node:test");
const assert = require("node:assert/strict");
const { mrrOf, PLAN_PRICES } = require("../src/v2/platform-revenue");

// MRR = ผลรวมราคาแพ็กเกจของแบรนด์ที่ยังไม่หมดอายุ (free ไม่นับ)
test("MRR counts only plans that are still valid", () => {
  const now = new Date("2026-11-05T00:00:00Z");
  const rows = [
    { plan: "pro", valid_until: "2026-12-05T00:00:00Z" },
    { plan: "starter", valid_until: "2026-11-20T00:00:00Z" },
    { plan: "loyalty", valid_until: null },          // no end date = still active
    { plan: "pro", valid_until: "2026-10-01T00:00:00Z" }, // expired → free again
    { plan: "free", valid_until: null }
  ];
  assert.deepEqual(mrrOf(rows, now), { mrr: 890 + 390 + 590, paying: 3 });
});

test("an empty platform has no MRR", () => {
  assert.deepEqual(mrrOf([], new Date()), { mrr: 0, paying: 0 });
  assert.deepEqual(mrrOf(null, new Date()), { mrr: 0, paying: 0 });
});

test("prices match the package table the shop sees", () => {
  assert.deepEqual(PLAN_PRICES, { free: 0, starter: 390, pro: 890, loyalty: 590 });
});
