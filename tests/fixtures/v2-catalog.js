// Catalog snapshots for the v2 options engine, matching supabase/seed.sql (same ids and rules),
// plus a court and a yoga class to cover customer-chosen duration and capacity > 1.

const BLOOM = "b1000000-0000-4000-8000-000000000001";
const BARBER = "b2000000-0000-4000-8000-000000000002";

const ids = {
  nan: "a1000000-0000-4000-8000-000000000001",
  bee: "a1000000-0000-4000-8000-000000000002",
  ploy: "a1000000-0000-4000-8000-000000000003",
  tong: "a2000000-0000-4000-8000-000000000001",
  ake: "a2000000-0000-4000-8000-000000000002",
  cut: "c1000000-0000-4000-8000-000000000001",
  colour: "c1000000-0000-4000-8000-000000000002",
  treatment: "c1000000-0000-4000-8000-000000000003",
  menCut: "c2000000-0000-4000-8000-000000000001",
  cutShave: "c2000000-0000-4000-8000-000000000002",
  court1: "d0000000-0000-4000-8000-000000000001",
  court2: "d0000000-0000-4000-8000-000000000002",
  courtHire: "e0000000-0000-4000-8000-000000000001",
  studio: "d0000000-0000-4000-8000-000000000011",
  yoga: "e0000000-0000-4000-8000-000000000011"
};

const everyDay = (open, close, closedDays = []) =>
  [0, 1, 2, 3, 4, 5, 6].map((d) => ({ day_of_week: d, is_open: !closedDays.includes(d), open_time: open, close_time: close }));

function bloom() {
  const hours = everyDay("10:00", "20:00");
  const resources = [
    { id: ids.nan, kind: "staff", name: "ช่างแนน", capacity: 1, sort_order: 1, active: true },
    { id: ids.bee, kind: "staff", name: "ช่างบี", capacity: 1, sort_order: 2, active: true },
    { id: ids.ploy, kind: "staff", name: "ช่างพลอย (ทำสีเท่านั้น)", capacity: 1, sort_order: 3, active: true }
  ];
  const offerings = [
    { id: ids.cut, category: "ตัด", name: "ตัดผมหญิง + สระไดร์", duration_mode: "fixed", duration_minutes: 60, buffer_after_minutes: 10, max_party_size: 1, sort_order: 1, active: true },
    { id: ids.colour, category: "สี", name: "ทำสีผม", duration_mode: "fixed", duration_minutes: 120, buffer_after_minutes: 15, max_party_size: 1, sort_order: 2, active: true },
    { id: ids.treatment, category: "ทรีตเมนต์", name: "ทรีตเมนต์บำรุงผม", duration_mode: "fixed", duration_minutes: 45, buffer_after_minutes: 0, max_party_size: 1, sort_order: 3, active: true }
  ];
  return {
    business: { id: BLOOM, timezone: "Asia/Bangkok" },
    settings: { min_lead_minutes: 30, slot_interval_minutes: 15, max_advance_days: 30 },
    flow: {
      entry: ["date", "offering"],
      require: ["offering", "date", "time"],
      optional: ["resource"],
      then: ["customer"],
      options: { show_any_staff: true, date_range_days: 30 }
    },
    hours,
    closures: [],
    resources,
    // ช่างบี is off on Wednesdays
    schedules: resources.flatMap((r) =>
      hours.map((h) => ({ resource_id: r.id, day_of_week: h.day_of_week, is_working: !(r.id === ids.bee && h.day_of_week === 3), start_time: "10:00", end_time: "20:00" }))
    ),
    timeOff: [],
    offerings,
    requirements: offerings.map((o) => ({ offering_id: o.id, kind: "staff", customer_picks: true, units_per_booking: "one" })),
    // ช่างพลอย does colour only
    offeringResources: offerings.flatMap((o) =>
      resources.filter((r) => !(r.id === ids.ploy && o.id !== ids.colour)).map((r) => ({ offering_id: o.id, resource_id: r.id }))
    ),
    busy: []
  };
}

function barber() {
  const hours = everyDay("09:00", "19:00", [1]);
  const resources = [
    { id: ids.tong, kind: "staff", name: "ช่างโต้ง", capacity: 1, sort_order: 1, active: true },
    { id: ids.ake, kind: "staff", name: "ช่างเอก", capacity: 1, sort_order: 2, active: true }
  ];
  const offerings = [
    { id: ids.menCut, category: null, name: "ตัดผมชาย", duration_mode: "fixed", duration_minutes: 30, buffer_after_minutes: 5, max_party_size: 1, sort_order: 1, active: true },
    { id: ids.cutShave, category: null, name: "ตัด + โกนหนวด", duration_mode: "fixed", duration_minutes: 45, buffer_after_minutes: 5, max_party_size: 1, sort_order: 2, active: true }
  ];
  return {
    business: { id: BARBER, timezone: "Asia/Bangkok" },
    settings: { min_lead_minutes: 15, slot_interval_minutes: 15, max_advance_days: 14 },
    flow: { entry: ["offering"], require: ["offering", "date", "time"], optional: [], then: ["customer"], options: { date_range_days: 14 } },
    hours,
    closures: [],
    resources,
    schedules: resources.flatMap((r) =>
      hours.map((h) => ({ resource_id: r.id, day_of_week: h.day_of_week, is_working: h.is_open, start_time: "09:00", end_time: "19:00" }))
    ),
    timeOff: [],
    offerings,
    requirements: offerings.map((o) => ({ offering_id: o.id, kind: "staff", customer_picks: false, units_per_booking: "one" })),
    offeringResources: offerings.flatMap((o) => resources.map((r) => ({ offering_id: o.id, resource_id: r.id }))),
    busy: []
  };
}

// Courts hired by the hour (customer picks court and 1–3 hours) and a yoga class of 12
function sports() {
  return {
    business: { id: "b3000000-0000-4000-8000-000000000003", timezone: "Asia/Bangkok" },
    settings: { min_lead_minutes: 0, slot_interval_minutes: 60, max_advance_days: 7 },
    flow: {
      entry: ["resource"],
      require: ["offering", "resource", "date", "time", "duration"],
      optional: ["party"],
      then: ["customer", "payment"],
      options: { date_range_days: 7 }
    },
    hours: everyDay("08:00", "23:00"),
    closures: [],
    resources: [
      { id: ids.court1, kind: "court", name: "สนาม 1", capacity: 1, sort_order: 1, active: true },
      { id: ids.court2, kind: "court", name: "สนาม 2", capacity: 1, sort_order: 2, active: true },
      { id: ids.studio, kind: "room", name: "ห้องโยคะ", capacity: 12, sort_order: 3, active: true }
    ],
    schedules: [],
    timeOff: [],
    offerings: [
      { id: ids.courtHire, category: null, name: "เช่าสนาม", duration_mode: "customer_choice", min_minutes: 60, max_minutes: 180, step_minutes: 60, buffer_after_minutes: 0, max_party_size: 1, sort_order: 1, active: true },
      { id: ids.yoga, category: null, name: "คลาสโยคะ", duration_mode: "fixed", duration_minutes: 60, buffer_after_minutes: 0, max_party_size: 4, sort_order: 2, active: true }
    ],
    requirements: [
      { offering_id: ids.courtHire, kind: "court", customer_picks: true, units_per_booking: "one" },
      { offering_id: ids.yoga, kind: "room", customer_picks: false, units_per_booking: "party_size" }
    ],
    offeringResources: [
      { offering_id: ids.courtHire, resource_id: ids.court1 },
      { offering_id: ids.courtHire, resource_id: ids.court2 },
      { offering_id: ids.yoga, resource_id: ids.studio }
    ],
    busy: []
  };
}

module.exports = { ids, bloom, barber, sports };
