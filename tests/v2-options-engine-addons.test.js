// Add-ons in the options engine (docs/FLEXIBLE_BOOKING_DESIGN.md §11): a court with rackets to rent
// (a resource of 3), a shower room (price only), and a coaching add-on that adds 30 minutes.
const test = require("node:test");
const assert = require("node:assert/strict");

const { getOptions, nextStep, reconcile, REASONS } = require("../src/v2/options-engine");
const { ids, sports } = require("./fixtures/v2-catalog");

const now = "2026-10-26T08:00:00+07:00";
const TUE = "2026-10-27";
const RACKETS = "f0000000-0000-4000-8000-000000000001";
const EQUIPMENT = "f1000000-0000-4000-8000-000000000001";
const EXTRAS = "f1000000-0000-4000-8000-000000000002";
const RACKET = "f2000000-0000-4000-8000-000000000001";
const SHOWER = "f2000000-0000-4000-8000-000000000002";
const COACH = "f2000000-0000-4000-8000-000000000003";

function courts() {
  const c = sports();
  c.resources.push({ id: RACKETS, kind: "ไม้แบด", name: "ไม้แบด", capacity: 3, sort_order: 9, active: true });
  c.addonGroups = [
    { id: EQUIPMENT, name: "อุปกรณ์", min_select: 0, max_select: null, sort_order: 1, active: true },
    { id: EXTRAS, name: "บริการเสริม", min_select: 0, max_select: 1, sort_order: 2, active: true }
  ];
  c.addonLinks = [
    { offering_id: ids.courtHire, group_id: EQUIPMENT },
    { offering_id: ids.courtHire, group_id: EXTRAS }
  ];
  c.addons = [
    { id: RACKET, group_id: EQUIPMENT, name: "เช่าไม้", price_unit: "per_unit", amount: 50, max_quantity: 4, adds_minutes: 0, uses_kind: "ไม้แบด", sort_order: 1, active: true },
    { id: SHOWER, group_id: EXTRAS, name: "ห้องอาบน้ำ", price_unit: "per_booking", amount: 150, max_quantity: 1, adds_minutes: 0, uses_kind: null, sort_order: 1, active: true },
    { id: COACH, group_id: EXTRAS, name: "โค้ชเพิ่ม 30 นาที", price_unit: "per_booking", amount: 300, max_quantity: 1, adds_minutes: 30, uses_kind: null, sort_order: 2, active: true }
  ];
  return c;
}

const busy = (resource_id, from, to, units = 1) => ({ resource_id, units, start_at: `${TUE}T${from}:00+07:00`, end_at: `${TUE}T${to}:00+07:00` });
const sel = { offeringId: ids.courtHire, resourceId: ids.court1, date: TUE, time: "10:00", durationMinutes: 60 };

test("after the hours, the add-ons step comes before the customer; {} answers it", () => {
  const c = courts();
  assert.equal(nextStep(c, { selected: sel, now }).step, "addons");
  assert.equal(nextStep(c, { selected: { ...sel, addons: {} }, now }).step, "customer");
  assert.equal(nextStep(sports(), { selected: sel, now }).step, "customer", "a shop without add-ons never sees the step");
});

test("each add-on is listed with its group, how many are left, and why one cannot be taken", () => {
  const c = courts();
  c.busy = [busy(RACKETS, "09:00", "12:00", 2), busy(ids.court1, "11:00", "12:00")];
  const result = getOptions(c, { ask: "addons", selected: sel, now });
  assert.deepEqual(result.groups, [
    { id: EQUIPMENT, name: "อุปกรณ์", minSelect: 0, maxSelect: null },
    { id: EXTRAS, name: "บริการเสริม", minSelect: 0, maxSelect: 1 }
  ]);
  assert.deepEqual(result.options.map((o) => [o.label, o.groupId, o.available, o.reason, o.maxQuantity]), [
    ["เช่าไม้", EQUIPMENT, true, null, 1], // 3 rackets, 2 out
    ["ห้องอาบน้ำ", EXTRAS, true, null, 1],
    ["โค้ชเพิ่ม 30 นาที", EXTRAS, false, REASONS.NOT_ENOUGH_TIME, 0] // 10:00–11:30 runs into the 11:00 booking
  ]);

  c.busy = [busy(RACKETS, "09:00", "12:00", 3)];
  const out = getOptions(c, { ask: "addons", selected: sel, now }).options.find((o) => o.value === RACKET);
  assert.deepEqual([out.available, out.reason, out.maxQuantity], [false, REASONS.RESOURCE_BUSY, 0]);
});

test("taken add-ons narrow the times: extra minutes need room, rented rackets must be free", () => {
  const c = courts();
  c.busy = [busy(ids.court1, "11:00", "12:00"), busy(RACKETS, "13:00", "14:00", 3)];
  const plain = getOptions(c, { ask: "time", selected: { ...sel, time: undefined, addons: {} }, now }).options.map((o) => o.value);
  const coached = getOptions(c, { ask: "time", selected: { ...sel, time: undefined, addons: { [COACH]: 1 } }, now }).options.map((o) => o.value);
  assert.ok(plain.includes("10:00") && !coached.includes("10:00"), "10:00 + 30 min runs into 11:00");
  assert.ok(coached.includes("09:30") || coached.includes("12:00"));
  const rented = getOptions(c, { ask: "time", selected: { ...sel, time: undefined, addons: { [RACKET]: 1 } }, now }).options.map((o) => o.value);
  assert.ok(plain.includes("13:00") && !rented.includes("13:00"), "no racket left at 13:00");
});

test("changing the time keeps add-ons that still fit and drops the rest with the reason", () => {
  const c = courts();
  c.busy = [busy(RACKETS, "14:00", "15:00", 2)];
  const picked = { ...sel, addons: { [RACKET]: 2, [SHOWER]: 1 } };
  assert.deepEqual(reconcile(c, { selected: picked, changed: "addons", now }), { selected: picked, cleared: [] });
  const moved = reconcile(c, { selected: { ...picked, time: "14:00" }, changed: "time", now });
  assert.deepEqual(moved.selected.addons, { [SHOWER]: 1 });
  assert.deepEqual(moved.cleared, [{ step: "addons", value: RACKET, reason: REASONS.RESOURCE_BUSY }]);
});

test("a group's maximum and a new offering clear add-ons; a group minimum keeps the step open", () => {
  const c = courts();
  const both = reconcile(c, { selected: { ...sel, addons: { [SHOWER]: 1, [COACH]: 1 } }, changed: "addons", now });
  assert.deepEqual(both.selected.addons, { [SHOWER]: 1 });
  assert.deepEqual(both.cleared, [{ step: "addons", value: COACH, reason: REASONS.ADDON_GROUP_RULE }]);

  const other = reconcile(c, { selected: { ...sel, addons: { [SHOWER]: 1 } }, changed: "offering", now });
  assert.equal(other.selected.addons, undefined);
  assert.deepEqual(other.cleared.filter((x) => x.step === "addons"), [{ step: "addons", value: SHOWER, reason: null }]);

  c.addonGroups[1].min_select = 1;
  assert.equal(nextStep(c, { selected: { ...sel, addons: {} }, now }).step, "addons", "must pick one extra");
  assert.equal(nextStep(c, { selected: { ...sel, addons: { [SHOWER]: 1 } }, now }).step, "customer");
});

test("add-ons are checked like every other choice: unknown ids and bad quantities are refused", () => {
  const c = courts();
  assert.throws(() => getOptions(c, { ask: "time", selected: { ...sel, addons: { "f2000000-0000-4000-8000-0000000000ff": 1 } }, now }), /unknown add-on/);
  assert.throws(() => getOptions(c, { ask: "time", selected: { ...sel, addons: { [RACKET]: 1.5 } }, now }), /whole number/);
  assert.throws(() => getOptions(c, { ask: "addons", selected: { ...sel, time: undefined }, now }), /date and time/);
});
