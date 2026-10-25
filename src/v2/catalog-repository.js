// Loads one shop's catalog snapshot for src/v2/options-engine.js from the step 1 tables.

async function findShop(db, slug) {
  if (typeof slug !== "string" || !/^[a-z0-9][a-z0-9-]{1,40}$/.test(slug)) return null;
  const { rows } = await db.query("select id, slug, name, kind, timezone from public.businesses where slug = $1", [slug]);
  return rows[0] ?? null;
}

const timeText = (t) => (t === null || t === undefined ? t : String(t).slice(0, 5));
const dateText = (d) => (d instanceof Date ? localDate(d) : String(d).slice(0, 10));
// pg returns `date` columns as local-midnight Date objects
const localDate = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

async function loadCatalog(db, shop) {
  const id = shop.id;
  const q = async (sql) => (await db.query(sql, [id])).rows;
  const [settings, flows, hours, closures, resources, schedules, timeOff, offerings, requirements, offeringResources, prices, busy] =
    await Promise.all([
      q("select min_lead_minutes, slot_interval_minutes, max_advance_days, hold_minutes from public.business_booking_settings where business_id = $1"),
      q("select entry, require, optional, \"then\", options from public.booking_flows where business_id = $1 and category is null"),
      q("select day_of_week, is_open, open_time, close_time from public.business_hours where business_id = $1"),
      q("select date::text as date, is_full_day, start_time, end_time from public.business_closures where business_id = $1 and date >= current_date - 1"),
      q("select id, kind, name, capacity, sort_order, active from public.resources where business_id = $1 and active"),
      q("select resource_id, day_of_week, is_working, start_time, end_time from public.resource_schedules where business_id = $1"),
      q("select resource_id, date::text as date, is_full_day, start_time, end_time from public.resource_time_off where business_id = $1 and date >= current_date - 1"),
      q(`select id, category, name, description, duration_mode, duration_minutes, min_minutes, max_minutes, step_minutes,
                buffer_after_minutes, max_party_size, sort_order, active
           from public.offerings where business_id = $1 and active`),
      q("select offering_id, kind, customer_picks, units_per_booking from public.offering_requirements where business_id = $1"),
      q("select offering_id, resource_id from public.offering_resources where business_id = $1"),
      q("select offering_id, unit, amount::float8 as amount from public.price_rules where business_id = $1"),
      q(`select br.booking_id, br.resource_id, br.units, lower(br.range) as start_at, upper(br.range) as end_at, b.hold_expires_at
           from public.booking_resources br join public.bookings b on b.id = br.booking_id
          where br.business_id = $1 and br.active and upper(br.range) > now()`)
    ]);

  const withTimes = (rows) => rows.map((r) => ({ ...r, start_time: timeText(r.start_time), end_time: timeText(r.end_time) }));
  return {
    business: { id, timezone: shop.timezone },
    settings: settings[0],
    flow: flows[0] ?? { entry: ["date", "offering"], require: ["offering", "date", "time"], optional: ["resource"], then: ["customer"], options: {} },
    hours: hours.map((h) => ({ ...h, open_time: timeText(h.open_time), close_time: timeText(h.close_time) })),
    closures: withTimes(closures).map((c) => ({ ...c, date: dateText(c.date) })),
    resources,
    schedules: withTimes(schedules),
    timeOff: withTimes(timeOff).map((t) => ({ ...t, date: dateText(t.date) })),
    offerings,
    requirements,
    offeringResources,
    prices,
    busy
  };
}

module.exports = { findShop, loadCatalog };
