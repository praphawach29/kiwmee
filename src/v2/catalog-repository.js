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

// Everything the options engine needs for one shop, in ONE query (each part is a subquery), so a
// booking step costs one round trip to the database instead of one per table. `id` is the SQL for
// the shop's id: a parameter, or a lookup by slug.
function catalogSql(id) {
  const list = (sql) => `coalesce((select json_agg(t) from (${sql}) t), '[]'::json)`;
  return `json_build_object(
    'settings', (select row_to_json(t) from (
        select min_lead_minutes, slot_interval_minutes, max_advance_days, hold_minutes,
               customer_can_cancel, customer_can_reschedule, customer_change_cutoff_hours,
               deposit_mode, deposit_value::float8 as deposit_value, payment_info
          from public.business_booking_settings where business_id = ${id}) t),
    'flows', ${list(`select entry, require, optional, "then", options from public.booking_flows where business_id = ${id} and category is null`)},
    'hours', ${list(`select day_of_week, is_open, open_time, close_time from public.business_hours where business_id = ${id}`)},
    'closures', ${list(`select date::text as date, is_full_day, start_time, end_time from public.business_closures where business_id = ${id} and date >= current_date - 1`)},
    'resources', ${list(`select id, kind, name, capacity, sort_order, active from public.resources where business_id = ${id} and active`)},
    'schedules', ${list(`select resource_id, day_of_week, is_working, start_time, end_time from public.resource_schedules where business_id = ${id}`)},
    'timeOff', ${list(`select resource_id, date::text as date, is_full_day, start_time, end_time from public.resource_time_off where business_id = ${id} and date >= current_date - 1`)},
    'offerings', ${list(`select id, category, name, description, duration_mode, duration_minutes, min_minutes, max_minutes, step_minutes,
                                buffer_after_minutes, max_party_size, sort_order, active
                           from public.offerings where business_id = ${id} and active`)},
    'requirements', ${list(`select offering_id, kind, customer_picks, units_per_booking from public.offering_requirements where business_id = ${id}`)},
    'offeringResources', ${list(`select offering_id, resource_id from public.offering_resources where business_id = ${id}`)},
    'prices', ${list(`select offering_id, unit, amount::float8 as amount from public.price_rules where business_id = ${id}`)},
    'busy', ${list(`select br.booking_id, br.resource_id, br.units, lower(br.range) as start_at, upper(br.range) as end_at, b.hold_expires_at
                      from public.booking_resources br join public.bookings b on b.id = br.booking_id
                     where br.business_id = ${id} and br.active and upper(br.range) > now()`)},
    'addonGroups', ${list(`select id, name, min_select, max_select, sort_order, active from public.addon_groups where business_id = ${id} and active`)},
    'addonLinks', ${list(`select offering_id, group_id from public.offering_addon_groups where business_id = ${id}`)},
    'addons', ${list(`select id, group_id, name, description, media, price_unit, amount::float8 as amount, max_quantity, adds_minutes, uses_kind, sort_order, active
                        from public.addons where business_id = ${id} and active`)}
  )`;
}

function shapeCatalog(shop, c) {
  const withTimes = (rows) => rows.map((r) => ({ ...r, start_time: timeText(r.start_time), end_time: timeText(r.end_time) }));
  return {
    business: { id: shop.id, timezone: shop.timezone },
    settings: c.settings ?? undefined,
    flow: c.flows[0] ?? { entry: ["date", "offering"], require: ["offering", "date", "time"], optional: ["resource"], then: ["customer"], options: {} },
    hours: c.hours.map((h) => ({ ...h, open_time: timeText(h.open_time), close_time: timeText(h.close_time) })),
    closures: withTimes(c.closures).map((x) => ({ ...x, date: dateText(x.date) })),
    resources: c.resources,
    schedules: withTimes(c.schedules),
    timeOff: withTimes(c.timeOff).map((t) => ({ ...t, date: dateText(t.date) })),
    offerings: c.offerings,
    requirements: c.requirements,
    offeringResources: c.offeringResources,
    prices: c.prices,
    busy: c.busy,
    addonGroups: c.addonGroups,
    addonLinks: c.addonLinks,
    addons: c.addons
  };
}

async function loadCatalog(db, shop) {
  const { rows } = await db.query(`select ${catalogSql("$1::uuid")} as catalog`, [shop.id]);
  return shapeCatalog(shop, rows[0].catalog);
}

/** The shop by its slug and its catalog in the same round trip: { shop, catalog } or null */
async function findShopWithCatalog(db, slug) {
  if (typeof slug !== "string" || !/^[a-z0-9][a-z0-9-]{1,40}$/.test(slug)) return null;
  const { rows } = await db.query(
    `select row_to_json(s) as shop, ${catalogSql("s.id")} as catalog
       from (select id, slug, name, kind, timezone from public.businesses where slug = $1) s`,
    [slug]
  );
  if (!rows[0]) return null;
  return { shop: rows[0].shop, catalog: shapeCatalog(rows[0].shop, rows[0].catalog) };
}

module.exports = { findShop, loadCatalog, findShopWithCatalog };
