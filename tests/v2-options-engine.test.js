const test = require("node:test");
const assert = require("node:assert/strict");

const { getOptions, nextStep, reconcile, REASONS } = require("../src/v2/options-engine");
const { ids, bloom, barber, sports } = require("./fixtures/v2-catalog");

// Monday 26 Oct 2026, 08:00 in Bangkok. Wednesday is the 28th (ช่างบี's day off).
const now = "2026-10-26T08:00:00+07:00";
const MON = "2026-10-26";
const TUE = "2026-10-27";
const WED = "2026-10-28";

const byValue = (options, value) => options.find((o) => o.value === value);
const times = (result) => result.options.map((o) => o.value);
const busy = (resource_id, date, from, to, extra = {}) => ({
  resource_id,
  units: 1,
  start_at: `${date}T${from}:00+07:00`,
  end_at: `${date}T${to}:00+07:00`,
  ...extra
});

// ---------- salon: start from a date ----------

test("date first: the calendar covers today plus date_range_days, all open at the salon", () => {
  const { options, reason } = getOptions(bloom(), { ask: "date", selected: {}, now });
  assert.equal(options.length, 31);
  assert.equal(options[0].value, MON);
  assert.ok(options.every((o) => o.available));
  assert.equal(reason, null);
});

test("date first: offerings on the chosen day, then stylists for that offering", () => {
  const offerings = getOptions(bloom(), { ask: "offering", selected: { date: WED }, now });
  assert.deepEqual(offerings.options.map((o) => [o.label, o.available]), [
    ["ตัดผมหญิง + สระไดร์", true],
    ["ทำสีผม", true],
    ["ทรีตเมนต์บำรุงผม", true]
  ]);

  const stylists = getOptions(bloom(), { ask: "resource", selected: { date: WED, offeringId: ids.cut }, now });
  // "anyone" first; ช่างพลอย does colour only so she is not listed for a cut; ช่างบี is off on Wednesdays
  assert.deepEqual(stylists.options.map((o) => [o.label, o.available, o.reason]), [
    ["any", true, null],
    ["ช่างแนน", true, null],
    ["ช่างบี", false, REASONS.STAFF_OFF]
  ]);
});

test("date first: a day the whole salon is booked shows as full with the reason", () => {
  const catalog = bloom();
  catalog.busy = [busy(ids.nan, TUE, "10:00", "20:00"), busy(ids.bee, TUE, "10:00", "20:00"), busy(ids.ploy, TUE, "10:00", "20:00")];
  const { options } = getOptions(catalog, { ask: "date", selected: {}, now });
  assert.deepEqual(byValue(options, TUE), { value: TUE, available: false, reason: REASONS.FULLY_BOOKED });
  assert.equal(byValue(options, WED).available, true);
});

test("a shop closure greys the day out as closed", () => {
  const catalog = bloom();
  catalog.closures = [{ date: TUE, is_full_day: true }];
  const { options } = getOptions(catalog, { ask: "date", selected: { offeringId: ids.cut }, now });
  assert.equal(byValue(options, TUE).reason, REASONS.BUSINESS_CLOSED);
});

// ---------- salon: start from an offering ----------

test("offering first: every offering is listed, then the days it can be done", () => {
  const offerings = getOptions(bloom(), { ask: "offering", selected: {}, now });
  assert.equal(offerings.options.length, 3);
  assert.ok(offerings.options.every((o) => o.available));

  const catalog = bloom();
  catalog.timeOff = [{ resource_id: ids.ploy, date: TUE, is_full_day: true }];
  const days = getOptions(catalog, { ask: "date", selected: { offeringId: ids.colour, resourceId: ids.ploy }, now });
  assert.equal(byValue(days.options, TUE).reason, REASONS.STAFF_OFF);
  assert.equal(byValue(days.options, WED).available, true);
});

test("a chosen stylist narrows the offerings to what they do", () => {
  const { options } = getOptions(bloom(), { ask: "offering", selected: { resourceId: ids.ploy }, now });
  assert.deepEqual(options.map((o) => o.value), [ids.colour]);
});

test("times respect bookings plus the buffer after each service", () => {
  const catalog = bloom();
  // ช่างแนน is busy 11:00–12:10 (a cut plus its 10-minute buffer)
  catalog.busy = [busy(ids.nan, TUE, "11:00", "12:10")];
  const withNan = getOptions(catalog, { ask: "time", selected: { offeringId: ids.cut, resourceId: ids.nan, date: TUE }, now });
  const t = times(withNan);
  assert.ok(!t.includes("10:00"), "10:00–11:00 plus 10 minutes of buffer runs into 11:00");
  assert.ok(!t.includes("12:00"));
  assert.ok(t.includes("12:15"));
  assert.ok(t.includes("19:00"), "a cut may end at closing time; the buffer may run past it");
  assert.ok(!t.includes("19:15"));
  assert.equal(withNan.options[0].startAt, `${TUE}T12:15:00+07:00`);

  // "anyone": ช่างบี is free at 10:00
  const anyone = getOptions(catalog, { ask: "time", selected: { offeringId: ids.cut, resourceId: null, date: TUE }, now });
  assert.equal(anyone.options[0].value, "10:00");
});

test("lead time: late in the evening today has no times left", () => {
  const late = "2026-10-26T19:30:00+07:00";
  const result = getOptions(bloom(), { ask: "time", selected: { offeringId: ids.treatment, date: MON }, now: late });
  assert.deepEqual(result.options, []);
  assert.equal(result.reason, REASONS.PAST_WORKING_HOURS);
  // today's first time is after now + 30 minutes of lead time
  const morning = getOptions(bloom(), { ask: "time", selected: { offeringId: ids.treatment, date: MON }, now: "2026-10-26T10:05:00+07:00" });
  assert.equal(morning.options[0].value, "10:45");
});

test("dates outside the booking window are refused with a reason", () => {
  const { options } = getOptions(bloom(), { ask: "offering", selected: { date: "2026-12-31" }, now });
  assert.ok(options.every((o) => o.reason === REASONS.OUTSIDE_BOOKING_WINDOW));
  const past = getOptions(bloom(), { ask: "time", selected: { offeringId: ids.cut, date: "2026-10-25" }, now });
  assert.equal(past.reason, REASONS.OUTSIDE_BOOKING_WINDOW);
});

test("an expired hold no longer blocks; the booking being moved does not block itself", () => {
  const catalog = bloom();
  catalog.busy = [
    busy(ids.nan, TUE, "10:00", "11:10", { booking_id: "held-1", hold_expires_at: "2026-10-26T07:50:00+07:00" }),
    busy(ids.nan, TUE, "13:00", "14:10", { booking_id: "moving" })
  ];
  const sel = { offeringId: ids.cut, resourceId: ids.nan, date: TUE };
  const t = times(getOptions(catalog, { ask: "time", selected: sel, now, excludeBookingId: "moving" }));
  assert.ok(t.includes("10:00"));
  assert.ok(t.includes("13:00"));
  const strict = times(getOptions(catalog, { ask: "time", selected: sel, now }));
  assert.ok(!strict.includes("13:00"));
});

// ---------- the order of steps ----------

test("salon: start page offers both ways in; each way ends with the same choices", () => {
  const c = bloom();
  assert.deepEqual(nextStep(c, { selected: {}, now }), { step: "start", choices: ["date", "offering"] });
  // from a date
  assert.equal(nextStep(c, { selected: { date: TUE }, now }).step, "offering");
  assert.equal(nextStep(c, { selected: { date: TUE, offeringId: ids.cut }, now }).step, "resource");
  assert.equal(nextStep(c, { selected: { date: TUE, offeringId: ids.cut, resourceId: null }, now }).step, "time");
  // from an offering
  assert.equal(nextStep(c, { selected: { offeringId: ids.cut }, now }).step, "resource");
  assert.equal(nextStep(c, { selected: { offeringId: ids.cut, resourceId: ids.nan }, now }).step, "date");
  assert.equal(nextStep(c, { selected: { offeringId: ids.cut, resourceId: ids.nan, date: TUE }, now }).step, "time");
  // both end at the customer's details
  assert.equal(nextStep(c, { selected: { offeringId: ids.cut, resourceId: null, date: TUE, time: "10:00" }, now }).step, "customer");
});

test("barber: always starts from the offering, the shop picks the barber", () => {
  const c = barber();
  assert.deepEqual(nextStep(c, { selected: {}, now }), { step: "offering" });
  assert.equal(nextStep(c, { selected: { offeringId: ids.menCut }, now }).step, "date");
  assert.equal(nextStep(c, { selected: { offeringId: ids.menCut, date: TUE }, now }).step, "time");
  assert.equal(nextStep(c, { selected: { offeringId: ids.menCut, date: TUE, time: "09:00" }, now }).step, "customer");

  const days = getOptions(c, { ask: "date", selected: { offeringId: ids.menCut }, now });
  assert.equal(days.options.length, 15);
  assert.equal(byValue(days.options, MON).reason, REASONS.BUSINESS_CLOSED);
  assert.equal(byValue(days.options, TUE).available, true);
  // no stylist to pick at the barber
  assert.deepEqual(getOptions(c, { ask: "resource", selected: { offeringId: ids.menCut }, now }).options, []);
});

test("barber: a time stays open while one of the two barbers is free", () => {
  const c = barber();
  c.busy = [busy(ids.tong, TUE, "09:00", "09:35")];
  const first = getOptions(c, { ask: "time", selected: { offeringId: ids.menCut, date: TUE }, now });
  assert.equal(first.options[0].value, "09:00");
  c.busy.push(busy(ids.ake, TUE, "09:00", "09:35"));
  const second = getOptions(c, { ask: "time", selected: { offeringId: ids.menCut, date: TUE }, now });
  assert.equal(second.options[0].value, "09:45");
});

// ---------- going back and changing a choice ----------

test("changing the date keeps the offering, drops a stylist who is off, always drops the time", () => {
  const catalog = bloom();
  catalog.timeOff = [{ resource_id: ids.ploy, date: WED, is_full_day: true }];
  const { selected, cleared } = reconcile(catalog, {
    selected: { offeringId: ids.colour, resourceId: ids.ploy, date: WED, time: "10:00" },
    changed: "date",
    now
  });
  assert.equal(selected.offeringId, ids.colour, "ช่างแนน/ช่างบี can still colour on Wednesday");
  assert.equal(selected.resourceId, undefined);
  assert.equal(selected.time, undefined);
  assert.deepEqual(cleared, [
    { step: "time", value: "10:00", reason: null },
    { step: "resource", value: ids.ploy, reason: REASONS.STAFF_OFF }
  ]);
});

test("changing the offering drops a stylist who does not do it", () => {
  const { selected, cleared } = reconcile(bloom(), {
    selected: { offeringId: ids.cut, resourceId: ids.ploy, date: TUE },
    changed: "offering",
    now
  });
  assert.equal(selected.resourceId, undefined);
  assert.deepEqual(cleared, [{ step: "resource", value: ids.ploy, reason: REASONS.NOT_OFFERED }]);
});

test("changing the date to one where the offering is full clears the offering with the reason", () => {
  const catalog = bloom();
  catalog.busy = [busy(ids.nan, TUE, "10:00", "20:00"), busy(ids.bee, TUE, "10:00", "20:00"), busy(ids.ploy, TUE, "10:00", "20:00")];
  const { selected, cleared } = reconcile(catalog, {
    selected: { offeringId: ids.colour, resourceId: null, date: TUE },
    changed: "date",
    now
  });
  assert.equal(selected.offeringId, undefined);
  assert.equal(selected.resourceId, null, "\"anyone\" stays");
  assert.deepEqual(cleared, [{ step: "offering", value: ids.colour, reason: REASONS.FULLY_BOOKED }]);
});

test("nothing is cleared when every choice still works", () => {
  const { selected, cleared } = reconcile(bloom(), {
    selected: { offeringId: ids.cut, resourceId: ids.nan, date: TUE, time: "11:00" },
    changed: "time",
    now
  });
  assert.deepEqual(cleared, []);
  assert.equal(selected.time, "11:00");
});

// ---------- courts and classes ----------

test("court: the customer picks the hours, and longer hires stop where the next booking starts", () => {
  const c = sports();
  c.busy = [busy(ids.court1, TUE, "12:00", "13:00")];
  const sel = { offeringId: ids.courtHire, resourceId: ids.court1, date: TUE, time: "10:00" };
  const durations = getOptions(c, { ask: "duration", selected: sel, now });
  assert.deepEqual(durations.options.map((o) => [o.value, o.available, o.reason]), [
    [60, true, null],
    [120, true, null],
    [180, false, REASONS.FULLY_BOOKED]
  ]);
  // The other court is free for three hours
  const other = getOptions(c, { ask: "duration", selected: { ...sel, resourceId: ids.court2 }, now });
  assert.ok(other.options.every((o) => o.available));
  // The court flow starts from the court, and asks for hours after the start time
  assert.deepEqual(nextStep(c, { selected: {}, now }), { step: "resource" });
  assert.equal(nextStep(c, { selected: { resourceId: ids.court1 }, now }).step, "offering");
  assert.equal(nextStep(c, { selected: { resourceId: ids.court1, offeringId: ids.courtHire, date: TUE, time: "10:00" }, now }).step, "duration");
  assert.equal(nextStep(c, { selected: { ...sel, durationMinutes: 120 }, now }).step, "customer");
});

test("class of 12: places run out by head count, not by the first booking", () => {
  const c = sports();
  c.busy = [
    busy(ids.studio, TUE, "18:00", "19:00", { units: 6 }),
    busy(ids.studio, TUE, "18:00", "19:00", { units: 4 })
  ];
  const sel = { offeringId: ids.yoga, date: TUE, time: "18:00" };
  const party = getOptions(c, { ask: "party", selected: sel, now });
  assert.deepEqual(party.options.map((o) => [o.value, o.available]), [
    [1, true],
    [2, true],
    [3, false],
    [4, false]
  ]);
  assert.equal(party.options[2].reason, REASONS.FULLY_BOOKED);
  // Bookings that do not overlap each other never add up
  c.busy = [busy(ids.studio, TUE, "17:00", "18:00", { units: 10 }), busy(ids.studio, TUE, "19:00", "20:00", { units: 10 })];
  assert.ok(getOptions(c, { ask: "party", selected: sel, now }).options.every((o) => o.available));
});

// ---------- bad input ----------

test("unknown ids and malformed values are refused, not guessed", () => {
  assert.throws(() => getOptions(bloom(), { ask: "date", selected: { offeringId: ids.menCut }, now }), /unknown offering/);
  assert.throws(() => getOptions(bloom(), { ask: "time", selected: { offeringId: ids.cut }, now }), /choose a date/);
  assert.throws(() => getOptions(bloom(), { ask: "colour", selected: {}, now }), /ask must be one of/);
  assert.throws(() => getOptions(bloom(), { ask: "date", selected: { date: "28/10/2026" }, now }), /YYYY-MM-DD/);
  assert.throws(() => getOptions(bloom(), { ask: "date", selected: {} }), /now is required/);
});
