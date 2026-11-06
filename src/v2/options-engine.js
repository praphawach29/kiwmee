// Flexible booking v2, step 2 (docs/FLEXIBLE_BOOKING_DESIGN.md §5, §6)
// "What is left for the next step": given whatever the customer has chosen so far, in any order,
// list the choices for the step being asked and whether each one can still be booked.
//
// Pure logic: the caller loads a catalog snapshot for one shop (rows as the step 1 tables hold
// them) and passes it in. No database, no clock (pass `now`), so every flow is unit-testable.
//
// catalog = {
//   business:            { timezone }
//   settings:            business_booking_settings row
//   flow:                booking_flows row ({ entry, require, optional, then, options })
//   hours, closures:     business_hours / business_closures rows
//   resources, schedules, timeOff:  resources / resource_schedules / resource_time_off rows
//   offerings, requirements, offeringResources:  offerings / offering_requirements / offering_resources rows
//   busy:                active booking_resources rows as { booking_id, resource_id, units, start_at, end_at,
//                        hold_expires_at } — end_at already includes the offering's buffer (range upper)
//   addonGroups, addonLinks, addons:  active addon_groups / offering_addon_groups / addons rows (design §11)
// }
// selected = { offeringId, resourceId, date, time, durationMinutes, partySize, addons }
//   undefined = not chosen yet. resourceId: null = the customer chose "anyone".
//   addons = { "<addon id>": quantity } — {} = asked and none taken. Their extra minutes lengthen the
//   booking and an add-on that uses a kind of resource needs one free for the whole booking.

const { ZERO_AVAILABILITY_REASONS } = require("./availability-reasons");
const { badRequest } = require("../errors");

const REASONS = {
  ...ZERO_AVAILABILITY_REASONS,
  OUTSIDE_BOOKING_WINDOW: "OUTSIDE_BOOKING_WINDOW", // before today or past max_advance_days
  NOT_OFFERED: "NOT_OFFERED", // the chosen resource does not do this offering (or the reverse)
  RESOURCE_BUSY: "RESOURCE_BUSY", // an add-on's racket / driver is all taken at that time
  NOT_ENOUGH_TIME: "NOT_ENOUGH_TIME", // an add-on's extra minutes run past the working hours or into the next booking
  ADDON_GROUP_RULE: "ADDON_GROUP_RULE", // more picks than the group allows
  RETURN_CLOSED: "RETURN_CLOSED" // a rental by the day: the shop is closed when it would come back
};

// When several days/offerings fail for different reasons, tell the customer the most useful one
const REASON_PRIORITY = [
  REASONS.FULLY_BOOKED,
  REASONS.PAST_WORKING_HOURS,
  REASONS.STAFF_OFF,
  REASONS.NO_WORKING_WINDOW,
  REASONS.BUSINESS_CLOSED,
  REASONS.RETURN_CLOSED,
  REASONS.NO_AVAILABLE_SLOTS,
  REASONS.NOT_OFFERED,
  REASONS.OUTSIDE_BOOKING_WINDOW
];

const ASKS = ["offering", "resource", "date", "time", "duration", "party", "addons"];
// Order of the steps after the starting one (design §5)
const STEP_ORDER = ["offering", "resource", "date", "time", "duration", "party"];
const RENTAL_ORDER = ["offering", "date", "duration", "time", "resource", "party"];
const SELECTED_KEY = {
  offering: "offeringId",
  resource: "resourceId",
  date: "date",
  time: "time",
  duration: "durationMinutes",
  party: "partySize",
  addons: "addons"
};

// ---------- time in the shop's timezone ----------

const offsetFormatters = new Map();

function offsetMinutes(timezone, instantMs) {
  let fmt = offsetFormatters.get(timezone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit"
    });
    offsetFormatters.set(timezone, fmt);
  }
  const p = Object.fromEntries(fmt.formatToParts(new Date(instantMs)).map((x) => [x.type, x.value]));
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return Math.round((asUtc - Math.floor(instantMs / 1000) * 1000) / 60000);
}

// "2026-10-26" + "10:30" in the shop's timezone → epoch ms
function localToMs(date, hhmm, timezone) {
  const [y, m, d] = date.split("-").map(Number);
  const [hh, mm] = hhmm.split(":").map(Number);
  const naive = Date.UTC(y, m - 1, d, hh, mm);
  let ms = naive - offsetMinutes(timezone, naive) * 60000;
  ms = naive - offsetMinutes(timezone, ms) * 60000; // second pass settles DST edges
  return ms;
}

function msToLocal(ms, timezone) {
  const shifted = new Date(ms + offsetMinutes(timezone, ms) * 60000);
  const iso = shifted.toISOString();
  return { date: iso.slice(0, 10), time: iso.slice(11, 16) };
}

function msToIso(ms, timezone) {
  const off = offsetMinutes(timezone, ms);
  const { date, time } = msToLocal(ms, timezone);
  const sign = off >= 0 ? "+" : "-";
  const abs = Math.abs(off);
  const pad = (n) => String(n).padStart(2, "0");
  return `${date}T${time}:00${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

function addDays(date, days) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function dayOfWeek(date) {
  return new Date(`${date}T00:00:00Z`).getUTCDay(); // 0 = Sunday, as business_hours
}

const hhmm = (t) => String(t).slice(0, 5);
const MINUTE = 60000;

// ---------- context ----------

function createContext(catalog, { now, excludeBookingId } = {}) {
  if (!now) throw new Error("now is required");
  const nowMs = new Date(now).getTime();
  const timezone = catalog.business?.timezone || "Asia/Bangkok";
  const settings = {
    min_lead_minutes: 15,
    slot_interval_minutes: 15,
    max_advance_days: 30,
    ...(catalog.settings || {})
  };
  const flow = catalog.flow || {};
  const today = msToLocal(nowMs, timezone).date;
  const lastDay = addDays(today, settings.max_advance_days);
  const rangeDays = Math.min(flow.options?.date_range_days ?? settings.max_advance_days, settings.max_advance_days);

  const offerings = (catalog.offerings || []).filter((o) => o.active !== false);
  offerings.sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0) || a.name.localeCompare(b.name));
  const resources = (catalog.resources || []).filter((r) => r.active !== false);
  resources.sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0) || a.name.localeCompare(b.name));

  const busy = (catalog.busy || [])
    .filter((b) => b.booking_id === undefined || b.booking_id !== excludeBookingId)
    .filter((b) => !b.hold_expires_at || new Date(b.hold_expires_at).getTime() > nowMs)
    .map((b) => ({
      resource_id: b.resource_id,
      units: b.units ?? 1,
      start: new Date(b.start_at).getTime(),
      end: new Date(b.end_at).getTime()
    }));

  return {
    timezone,
    settings,
    flow,
    nowMs,
    cutoffMs: nowMs + settings.min_lead_minutes * MINUTE,
    today,
    lastDay,
    dates: Array.from({ length: rangeDays + 1 }, (_, i) => addDays(today, i)),
    offerings,
    offeringById: new Map(offerings.map((o) => [o.id, o])),
    resources,
    resourceById: new Map(resources.map((r) => [r.id, r])),
    requirements: catalog.requirements || [],
    offeringResources: catalog.offeringResources || [],
    hours: catalog.hours || [],
    closures: catalog.closures || [],
    schedules: catalog.schedules || [],
    timeOff: catalog.timeOff || [],
    busy,
    addonGroups: (catalog.addonGroups || []).filter((g) => g.active !== false),
    addonLinks: catalog.addonLinks || [],
    addonById: new Map((catalog.addons || []).filter((a) => a.active !== false).map((a) => [a.id, a])),
    dayCache: new Map()
  };
}

// ---------- add-ons ----------

// The groups an offering offers, each with its add-ons in order (groups without any are left out)
function addonGroupsFor(ctx, offeringId) {
  const linked = new Set(ctx.addonLinks.filter((l) => l.offering_id === offeringId).map((l) => l.group_id));
  const all = [...ctx.addonById.values()];
  return ctx.addonGroups
    .filter((g) => linked.has(g.id))
    .map((g) => ({
      ...g,
      addons: all.filter((a) => a.group_id === g.id).sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0) || a.name.localeCompare(b.name))
    }))
    .filter((g) => g.addons.length > 0)
    .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0) || a.name.localeCompare(b.name));
}

// The picks that apply to this offering, as [{ addon, quantity }]
function picksFor(ctx, offeringId, addons) {
  if (!addons) return [];
  const offered = new Set(addonGroupsFor(ctx, offeringId).flatMap((g) => g.addons.map((a) => a.id)));
  return Object.entries(addons)
    .filter(([id, quantity]) => quantity > 0 && offered.has(id))
    .map(([id, quantity]) => ({ addon: ctx.addonById.get(id), quantity }));
}

// Each group's minimum met, and no group over its maximum
function groupRulesMet(ctx, offeringId, addons) {
  const picks = picksFor(ctx, offeringId, addons);
  return addonGroupsFor(ctx, offeringId).every((g) => {
    const n = picks.filter((p) => p.addon.group_id === g.id).length;
    return n >= (g.min_select ?? 0) && (g.max_select === null || g.max_select === undefined || n <= g.max_select);
  });
}

function requirementsOf(ctx, offeringId) {
  const reqs = ctx.requirements.filter((r) => r.offering_id === offeringId);
  // An offering with no requirement row still needs one of the resources linked to it
  if (reqs.length > 0) return reqs;
  const kinds = new Set(
    ctx.offeringResources
      .filter((link) => link.offering_id === offeringId)
      .map((link) => ctx.resourceById.get(link.resource_id)?.kind)
      .filter(Boolean)
  );
  return [...kinds].map((kind) => ({ offering_id: offeringId, kind, customer_picks: false, units_per_booking: "one" }));
}

function resourcesFor(ctx, offeringId, kind) {
  const linked = new Set(ctx.offeringResources.filter((l) => l.offering_id === offeringId).map((l) => l.resource_id));
  return ctx.resources.filter((r) => r.kind === kind && linked.has(r.id));
}

function canDo(ctx, resourceId, offeringId) {
  const resource = ctx.resourceById.get(resourceId);
  if (!resource) return false;
  return requirementsOf(ctx, offeringId).some((req) => req.kind === resource.kind) &&
    resourcesFor(ctx, offeringId, resource.kind).some((r) => r.id === resourceId);
}

const DAY_MINUTES = 1440;
const byDays = (offering) => offering.duration_mode === "days";

function durationsOf(offering) {
  // rented by the day: 24-hour periods, back at the same time of day
  if (byDays(offering)) {
    const out = [];
    for (let d = offering.min_days; d <= offering.max_days; d++) out.push(d * DAY_MINUTES);
    return out;
  }
  if (offering.duration_mode !== "customer_choice") return [offering.duration_minutes];
  const out = [];
  for (let m = offering.min_minutes; m <= offering.max_minutes; m += offering.step_minutes) out.push(m);
  return out;
}

// The shop's open window on a date, or why it is closed
function shopDay(ctx, date) {
  const key = `shop:${date}`;
  if (ctx.dayCache.has(key)) return ctx.dayCache.get(key);
  let result;
  const hours = ctx.hours.find((h) => h.day_of_week === dayOfWeek(date)) ||
    (ctx.hours.length === 0 ? { is_open: true, open_time: "10:00", close_time: "19:00" } : null);
  const closures = ctx.closures.filter((c) => String(c.date).slice(0, 10) === date);
  if (!hours || !hours.is_open || closures.some((c) => c.is_full_day)) {
    result = { closed: true };
  } else {
    result = {
      closed: false,
      open: localToMs(date, hhmm(hours.open_time), ctx.timezone),
      close: localToMs(date, hhmm(hours.close_time), ctx.timezone),
      blocked: closures.map((c) => ({
        start: localToMs(date, hhmm(c.start_time), ctx.timezone),
        end: localToMs(date, hhmm(c.end_time), ctx.timezone)
      }))
    };
  }
  ctx.dayCache.set(key, result);
  return result;
}

// One resource's working window on a date (shop hours ∩ its schedule − time off)
function resourceDay(ctx, resourceId, date) {
  const key = `${resourceId}:${date}`;
  if (ctx.dayCache.has(key)) return ctx.dayCache.get(key);
  const shop = shopDay(ctx, date);
  let result = { working: false };
  if (!shop.closed) {
    const schedule = ctx.schedules.find((s) => s.resource_id === resourceId && s.day_of_week === dayOfWeek(date));
    const off = ctx.timeOff.filter((t) => t.resource_id === resourceId && String(t.date).slice(0, 10) === date);
    // No schedule row for that day = works the shop's hours
    const works = schedule ? schedule.is_working : true;
    if (works && !off.some((t) => t.is_full_day)) {
      const start = schedule ? Math.max(shop.open, localToMs(date, hhmm(schedule.start_time), ctx.timezone)) : shop.open;
      const end = schedule ? Math.min(shop.close, localToMs(date, hhmm(schedule.end_time), ctx.timezone)) : shop.close;
      if (start < end) {
        result = {
          working: true,
          start,
          end,
          blocked: [
            ...shop.blocked,
            ...off.map((t) => ({
              start: localToMs(date, hhmm(t.start_time), ctx.timezone),
              end: localToMs(date, hhmm(t.end_time), ctx.timezone)
            }))
          ],
          busy: ctx.busy.filter((b) => b.resource_id === resourceId)
        };
      }
    }
  }
  ctx.dayCache.set(key, result);
  return result;
}

const overlaps = (aStart, aEnd, bStart, bEnd) => aStart < bEnd && aEnd > bStart;

// Can this resource take `units` more for [start, end) plus the buffer up to endWithBuffer?
function resourceFree(ctx, resource, date, start, end, endWithBuffer, units) {
  const day = resourceDay(ctx, resource.id, date);
  if (!day.working || start < day.start || end > day.end) return "outside";
  if (day.blocked.some((b) => overlaps(start, end, b.start, b.end))) return "blocked";
  const clashing = day.busy.filter((b) => overlaps(start, endWithBuffer, b.start, b.end));
  if (clashing.length === 0) return units <= resource.capacity ? "ok" : "booked";
  if (resource.capacity === 1) return "booked";
  // Capacity > 1: the busiest moment inside the range decides
  const points = [start, ...clashing.map((b) => b.start).filter((t) => t > start && t < endWithBuffer)];
  const peak = Math.max(...points.map((t) => clashing.filter((b) => b.start <= t && t < b.end).reduce((s, b) => s + b.units, 0)));
  return peak + units <= resource.capacity ? "ok" : "booked";
}

// How many more units this resource can take over the range (0 when it is not working then)
function freeUnits(ctx, resource, date, start, end, endWithBuffer) {
  const day = resourceDay(ctx, resource.id, date);
  if (!day.working || start < day.start || end > day.end) return 0;
  if (day.blocked.some((b) => overlaps(start, end, b.start, b.end))) return 0;
  const clashing = day.busy.filter((b) => overlaps(start, endWithBuffer, b.start, b.end));
  if (clashing.length === 0) return resource.capacity;
  const points = [start, ...clashing.map((b) => b.start).filter((t) => t > start && t < endWithBuffer)];
  const peak = Math.max(...points.map((t) => clashing.filter((b) => b.start <= t && t < b.end).reduce((sum, b) => sum + b.units, 0)));
  return Math.max(resource.capacity - peak, 0);
}

// ---------- rentals over several days (design 11.7) ----------

// Is the shop open at this moment of its local date? (pick-up and return of a rental by the day)
function shopOpenAt(ctx, date, ms) {
  const day = shopDay(ctx, date);
  if (day.closed || ms < day.open || ms > day.close) return false;
  return !day.blocked.some((b) => ms >= b.start && ms < b.end);
}

// How many more units a resource can lend over [start, endWithBuffer) across days: not when it is marked
// off on any day of it; working hours do not matter (the item is with the customer)
function spanFreeUnits(ctx, resource, start, endWithBuffer) {
  const first = msToLocal(start, ctx.timezone).date;
  const last = msToLocal(endWithBuffer, ctx.timezone).date;
  if (ctx.timeOff.some((t) => t.resource_id === resource.id && String(t.date).slice(0, 10) >= first && String(t.date).slice(0, 10) <= last)) return 0;
  const clashing = ctx.busy.filter((b) => b.resource_id === resource.id && overlaps(start, endWithBuffer, b.start, b.end));
  if (clashing.length === 0) return resource.capacity;
  const points = [start, ...clashing.map((b) => b.start).filter((t) => t > start && t < endWithBuffer)];
  const peak = Math.max(...points.map((t) => clashing.filter((b) => b.start <= t && t < b.end).reduce((sum, b) => sum + b.units, 0)));
  return Math.max(resource.capacity - peak, 0);
}

function spanFree(ctx, resource, start, endWithBuffer, units) {
  const first = msToLocal(start, ctx.timezone).date;
  const last = msToLocal(endWithBuffer, ctx.timezone).date;
  if (ctx.timeOff.some((t) => t.resource_id === resource.id && String(t.date).slice(0, 10) >= first && String(t.date).slice(0, 10) <= last)) return "outside";
  return spanFreeUnits(ctx, resource, start, endWithBuffer) >= units ? "ok" : "booked";
}

// Spread each add-on's quantity over the free resources of its kind (as booking_plan does).
// Returns the extra takes, or null when one runs out. `skip` = resources the booking already holds.
// span = a rental by the day (the add-on goes along for all of it).
function takeAddonResources(ctx, picks, date, start, end, endWithBuffer, skip, span = false) {
  const used = new Set(skip);
  const taken = [];
  for (const { addon, quantity } of picks) {
    if (!addon.uses_kind) continue;
    let need = quantity;
    for (const res of ctx.resources) {
      if (need <= 0) break;
      if (res.kind !== addon.uses_kind || used.has(res.id)) continue;
      const take = Math.min(need, span ? spanFreeUnits(ctx, res, start, endWithBuffer) : freeUnits(ctx, res, date, start, end, endWithBuffer));
      if (take <= 0) continue;
      used.add(res.id);
      taken.push({ resourceId: res.id, kind: res.kind, units: take, addonId: addon.id });
      need -= take;
    }
    if (need > 0) return null;
  }
  return taken;
}

// ---------- one offering on one day ----------

// Every start time on `date` where the offering can be booked, each with the resources it would take.
// Returns { starts, reason } — reason explains an empty list.
function evaluateDay(ctx, { offering, date, durationMinutes, partySize, resourceId, time, firstOnly, addons }) {
  if (date < ctx.today || date > ctx.lastDay) return { starts: [], reason: REASONS.OUTSIDE_BOOKING_WINDOW };
  const shop = shopDay(ctx, date);
  if (shop.closed) return { starts: [], reason: REASONS.BUSINESS_CLOSED };

  const pinned = resourceId ? ctx.resourceById.get(resourceId) : null;
  const reqs = requirementsOf(ctx, offering.id).map((req) => {
    let pool = resourcesFor(ctx, offering.id, req.kind);
    if (pinned && pinned.kind === req.kind) pool = pool.filter((r) => r.id === pinned.id);
    return { req, pool, units: req.units_per_booking === "party_size" ? partySize : 1 };
  });
  if (reqs.length === 0 || reqs.some((r) => r.pool.length === 0)) return { starts: [], reason: REASONS.NOT_OFFERED };
  if (byDays(offering)) return evaluateRental(ctx, { offering, date, durationMinutes, reqs, time, firstOnly, addons, shop });
  if (reqs.some((r) => r.pool.every((res) => !resourceDay(ctx, res.id, date).working))) {
    return { starts: [], reason: pinned ? REASONS.STAFF_OFF : REASONS.NO_WORKING_WINDOW };
  }

  const step = ctx.settings.slot_interval_minutes * MINUTE;
  const picks = picksFor(ctx, offering.id, addons);
  const extra = picks.reduce((sum, p) => sum + (p.addon.adds_minutes || 0) * p.quantity, 0);
  const length = (durationMinutes + extra) * MINUTE;
  const buffer = (offering.buffer_after_minutes || 0) * MINUTE;
  const only = time ? localToMs(date, time, ctx.timezone) : null;
  const starts = [];
  let candidates = 0;
  let future = 0;
  let sawBooked = false;

  // Start times line up with the shop's opening time, so every resource offers the same grid
  for (let start = shop.open; start + length <= shop.close; start += step) {
    if (only !== null && start !== only) continue;
    candidates++;
    if (start <= ctx.cutoffMs) continue;
    future++;
    const end = start + length;
    const taken = [];
    for (const { req, pool, units } of reqs) {
      let found = null;
      for (const res of pool) {
        const verdict = resourceFree(ctx, res, date, start, end, end + buffer, units);
        if (verdict === "ok") {
          found = res;
          break;
        }
        if (verdict === "booked") sawBooked = true;
      }
      if (!found) break;
      taken.push({ resourceId: found.id, kind: req.kind, units });
    }
    if (taken.length === reqs.length) {
      const extras = takeAddonResources(ctx, picks, date, start, end, end + buffer, taken.map((t) => t.resourceId));
      if (!extras) {
        sawBooked = true;
        continue;
      }
      starts.push({ start, end, endWithBuffer: end + buffer, resources: [...taken, ...extras] });
      if (firstOnly) break;
    }
  }

  if (starts.length > 0) return { starts, reason: null };
  if (candidates > 0 && future === 0) return { starts, reason: REASONS.PAST_WORKING_HOURS };
  if (sawBooked) return { starts, reason: REASONS.FULLY_BOOKED };
  return { starts, reason: REASONS.NO_AVAILABLE_SLOTS };
}

// A rental by the day: picked up at a time the shop is open on `date`, back at the same time of day
// `days` later (the shop must be open then too); the items must be free all the way through.
function evaluateRental(ctx, { offering, date, durationMinutes, reqs, time, firstOnly, addons, shop }) {
  const step = ctx.settings.slot_interval_minutes * MINUTE;
  const picks = picksFor(ctx, offering.id, addons);
  const length = durationMinutes * MINUTE;
  const buffer = (offering.buffer_after_minutes || 0) * MINUTE;
  const only = time ? localToMs(date, time, ctx.timezone) : null;
  const starts = [];
  let candidates = 0;
  let future = 0;
  let sawBooked = false;
  let returnClosed = false;

  for (let start = shop.open; start < shop.close; start += step) {
    if (only !== null && start !== only) continue;
    if (!shopOpenAt(ctx, date, start)) continue;
    candidates++;
    if (start <= ctx.cutoffMs) continue;
    future++;
    // whole 24-hour periods, as booking_plan adds them
    const end = start + length;
    if (!shopOpenAt(ctx, msToLocal(end, ctx.timezone).date, end)) {
      returnClosed = true;
      continue;
    }
    const taken = [];
    for (const { req, pool, units } of reqs) {
      let found = null;
      for (const res of pool) {
        const verdict = spanFree(ctx, res, start, end + buffer, units);
        if (verdict === "ok") {
          found = res;
          break;
        }
        if (verdict === "booked") sawBooked = true;
      }
      if (!found) break;
      taken.push({ resourceId: found.id, kind: req.kind, units });
    }
    if (taken.length === reqs.length) {
      const extras = takeAddonResources(ctx, picks, date, start, end, end + buffer, taken.map((t) => t.resourceId), true);
      if (!extras) {
        sawBooked = true;
        continue;
      }
      starts.push({ start, end, endWithBuffer: end + buffer, resources: [...taken, ...extras] });
      if (firstOnly) break;
    }
  }

  if (starts.length > 0) return { starts, reason: null };
  if (candidates > 0 && future === 0) return { starts, reason: REASONS.PAST_WORKING_HOURS };
  if (sawBooked) return { starts, reason: REASONS.FULLY_BOOKED };
  if (returnClosed) return { starts, reason: REASONS.RETURN_CLOSED };
  return { starts, reason: REASONS.NO_AVAILABLE_SLOTS };
}

function strongest(reasons) {
  for (const r of REASON_PRIORITY) if (reasons.has(r)) return r;
  return REASONS.NO_AVAILABLE_SLOTS;
}

// Offerings, dates and durations still open given the selection (free dimensions widen to all)
function domains(ctx, sel) {
  let offerings = sel.offeringId ? [ctx.offeringById.get(sel.offeringId)] : ctx.offerings;
  if (sel.resourceId) offerings = offerings.filter((o) => canDo(ctx, sel.resourceId, o.id));
  const dates = sel.date ? [sel.date] : ctx.dates;
  return { offerings, dates };
}

// Walk every combination left open by the selection. visit() returns true to stop early.
function search(ctx, sel, { firstOnly, visit }) {
  const reasons = new Set();
  const { offerings, dates } = domains(ctx, sel);
  if (offerings.length === 0) return REASONS.NOT_OFFERED;
  for (const offering of offerings) {
    const party = sel.partySize ?? 1;
    if (party > offering.max_party_size) {
      reasons.add(REASONS.NOT_OFFERED);
      continue;
    }
    const durations = sel.durationMinutes ? [sel.durationMinutes] : durationsOf(offering);
    for (const date of dates) {
      for (const durationMinutes of durations) {
        if (!durationsOf(offering).includes(durationMinutes)) {
          reasons.add(REASONS.NOT_OFFERED);
          continue;
        }
        const { starts, reason } = evaluateDay(ctx, {
          offering,
          date,
          durationMinutes,
          partySize: party,
          resourceId: sel.resourceId,
          time: sel.time,
          firstOnly,
          addons: sel.addons
        });
        if (reason) reasons.add(reason);
        for (const s of starts) if (visit({ offering, date, durationMinutes, ...s })) return null;
      }
    }
  }
  return strongest(reasons);
}

function exists(ctx, sel) {
  let found = false;
  const reason = search(ctx, sel, { firstOnly: true, visit: () => (found = true) });
  return found ? { available: true, reason: null } : { available: false, reason };
}

// ---------- public API ----------

function normalizeSelected(ctx, selected = {}) {
  const sel = { ...selected };
  for (const key of Object.keys(sel)) if (sel[key] === "") sel[key] = undefined;
  if (sel.offeringId && !ctx.offeringById.has(sel.offeringId)) throw badRequest("unknown offering");
  if (sel.resourceId && !ctx.resourceById.has(sel.resourceId)) throw badRequest("unknown resource");
  if (sel.date && !/^\d{4}-\d{2}-\d{2}$/.test(sel.date)) throw badRequest("date must be YYYY-MM-DD");
  if (sel.time && !/^\d{2}:\d{2}$/.test(sel.time)) throw badRequest("time must be HH:MM");
  if (sel.durationMinutes !== undefined && sel.durationMinutes !== null) sel.durationMinutes = Number(sel.durationMinutes);
  if (sel.partySize !== undefined && sel.partySize !== null) {
    sel.partySize = Number(sel.partySize);
    if (!Number.isInteger(sel.partySize) || sel.partySize < 1) throw badRequest("partySize must be a positive integer");
  }
  if (sel.addons !== undefined && sel.addons !== null) {
    if (typeof sel.addons !== "object" || Array.isArray(sel.addons)) throw badRequest("addons must be an object");
    const addons = {};
    for (const [id, quantity] of Object.entries(sel.addons)) {
      if (!ctx.addonById.has(id)) throw badRequest("unknown add-on");
      if (!Number.isInteger(quantity) || quantity < 0 || quantity > 1000) throw badRequest("add-on quantity must be a whole number");
      if (quantity > 0) addons[id] = quantity;
    }
    sel.addons = addons;
  } else {
    delete sel.addons;
  }
  return sel;
}

// Resources the customer may pick for an offering (requirements with customer_picks)
function pickableResources(ctx, offeringId) {
  const offerings = offeringId ? [ctx.offeringById.get(offeringId)] : ctx.offerings;
  const ids = new Set();
  for (const o of offerings) {
    for (const req of requirementsOf(ctx, o.id).filter((r) => r.customer_picks)) {
      for (const r of resourcesFor(ctx, o.id, req.kind)) ids.add(r.id);
    }
  }
  return ctx.resources.filter((r) => ids.has(r.id));
}

function requireOffering(ctx, sel, ask) {
  if (!sel.offeringId) throw badRequest(`choose an offering before asking for ${ask}`);
  return ctx.offeringById.get(sel.offeringId);
}

/**
 * The choices for step `ask`, each marked available or not (with a reason) given `selected`.
 * The asked step's own value in `selected` is ignored, so the same call serves changing it.
 *   ask "time" lists only start times that can be booked; an empty list comes with `reason`.
 * Returns { ask, options: [{ value, label?, available, reason, ... }], reason }
 */
function getOptions(catalog, { ask, selected, now, excludeBookingId } = {}) {
  if (!ASKS.includes(ask)) throw badRequest(`ask must be one of ${ASKS.join(", ")}`);
  const ctx = createContext(catalog, { now, excludeBookingId });
  const sel = normalizeSelected(ctx, selected);
  delete sel[SELECTED_KEY[ask]];

  let options;
  if (ask === "offering") {
    let offerings = ctx.offerings;
    if (sel.resourceId) offerings = offerings.filter((o) => canDo(ctx, sel.resourceId, o.id));
    options = offerings.map((o) => ({
      value: o.id,
      label: o.name,
      category: o.category ?? null,
      ...exists(ctx, { ...sel, offeringId: o.id })
    }));
  } else if (ask === "resource") {
    const pickable = pickableResources(ctx, sel.offeringId);
    options = pickable.map((r) => ({ value: r.id, label: r.name, kind: r.kind, ...exists(ctx, { ...sel, resourceId: r.id }) }));
    if (ctx.flow.options?.show_any_staff && options.length > 1) {
      const any = exists(ctx, { ...sel, resourceId: undefined });
      options.unshift({ value: null, label: "any", ...any });
    }
  } else if (ask === "date") {
    options = ctx.dates.map((date) => ({ value: date, ...exists(ctx, { ...sel, date }) }));
  } else if (ask === "time") {
    if (!sel.date) throw badRequest("choose a date before asking for time");
    const seen = new Map();
    const reason = search(ctx, sel, {
      firstOnly: false,
      visit: ({ start }) => {
        if (!seen.has(start)) seen.set(start, true);
        return false;
      }
    });
    options = [...seen.keys()]
      .sort((a, b) => a - b)
      .map((start) => ({
        value: msToLocal(start, ctx.timezone).time,
        startAt: msToIso(start, ctx.timezone),
        available: true,
        reason: null
      }));
    return { ask, options, reason: options.length ? null : reason };
  } else if (ask === "duration") {
    const offering = requireOffering(ctx, sel, ask);
    options = durationsOf(offering).map((m) => ({ value: m, ...exists(ctx, { ...sel, durationMinutes: m }) }));
  } else if (ask === "party") {
    const offering = requireOffering(ctx, sel, ask);
    options = Array.from({ length: offering.max_party_size }, (_, i) => i + 1).map((n) => ({
      value: n,
      ...exists(ctx, { ...sel, partySize: n })
    }));
  } else {
    return addonOptions(ctx, sel);
  }

  const reason = options.some((o) => o.available) ? null : strongest(new Set(options.map((o) => o.reason).filter(Boolean)));
  return { ask, options, reason };
}

// The add-ons of the chosen offering at the chosen time: each one on its own, how many are left
// (an add-on that uses a kind of resource), and why one cannot be taken. Picks that only fail
// together (two add-ons after the last racket) are caught when the booking is made.
function addonOptions(ctx, sel) {
  const offering = requireOffering(ctx, sel, "addons");
  if (!sel.date || !sel.time) throw badRequest("choose a date and time before asking for add-ons");
  const groups = addonGroupsFor(ctx, offering.id);
  let slot = null;
  search(ctx, sel, { firstOnly: true, visit: (s) => (slot = s) });
  const options = [];
  for (const g of groups) {
    for (const addon of g.addons) {
      const base = { value: addon.id, label: addon.name, groupId: g.id };
      if (!slot) {
        options.push({ ...base, available: false, reason: REASONS.NO_AVAILABLE_SLOTS, maxQuantity: 0 });
        continue;
      }
      const one = exists(ctx, { ...sel, addons: { [addon.id]: 1 } });
      let left = addon.max_quantity;
      if (addon.uses_kind) {
        const end = slot.end + (addon.adds_minutes || 0) * MINUTE;
        const buffer = slot.endWithBuffer - slot.end;
        const held = new Set(slot.resources.map((r) => r.resourceId));
        left = Math.min(left, ctx.resources
          .filter((r) => r.kind === addon.uses_kind && !held.has(r.id))
          .reduce((sum, r) => sum + freeUnits(ctx, r, slot.date, slot.start, end, end + buffer), 0));
      }
      const available = one.available && left > 0;
      options.push({
        ...base,
        available,
        reason: available ? null : addon.uses_kind && left <= 0 ? REASONS.RESOURCE_BUSY : REASONS.NOT_ENOUGH_TIME,
        maxQuantity: available ? left : 0
      });
    }
  }
  return {
    ask: "addons",
    options,
    reason: null,
    groups: groups.map((g) => ({ id: g.id, name: g.name, minSelect: g.min_select ?? 0, maxSelect: g.max_select ?? null }))
  };
}

// Which steps apply to this shop's flow and the selection so far (skips ones that do not apply)
function stepApplies(ctx, step, sel) {
  const offering = sel.offeringId ? ctx.offeringById.get(sel.offeringId) : null;
  if (step === "resource") return pickableResources(ctx, sel.offeringId).length > 0;
  if (step === "duration") return offering ? offering.duration_mode === "customer_choice" || byDays(offering) : true;
  if (step === "party") return offering ? offering.max_party_size > 1 : true;
  return true;
}

/**
 * The step to show next. "start" = the page where the customer picks how to begin (more than one
 * entry); after the booking steps are done, the flow's `then` steps follow, then "done".
 * resourceId: null counts as chosen ("anyone"); undefined means not asked yet.
 */
function nextStep(catalog, { selected, now }) {
  const ctx = createContext(catalog, { now });
  const sel = normalizeSelected(ctx, selected);
  const flow = ctx.flow;
  const steps = [...(flow.require || ["offering", "date", "time"]), ...(flow.optional || [])];
  // a rental by the day always asks how many days, whatever the shop's flow lists
  if (sel.offeringId && byDays(ctx.offeringById.get(sel.offeringId)) && !steps.includes("duration")) steps.push("duration");
  const chosen = (step) => {
    const v = sel[SELECTED_KEY[step]];
    return step === "resource" ? v !== undefined : v !== undefined && v !== null;
  };
  const entry = flow.entry || ["date", "offering"];
  if (!steps.some(chosen)) return entry.length > 1 ? { step: "start", choices: entry } : { step: entry[0] };
  // a rental by the day: when to pick up and for how long first, then the time, then which one
  const order = sel.offeringId && byDays(ctx.offeringById.get(sel.offeringId)) ? RENTAL_ORDER : STEP_ORDER;
  for (const step of order) {
    if (steps.includes(step) && !chosen(step) && stepApplies(ctx, step, sel)) return { step };
  }
  // add-ons come after the time (their resources and extra minutes depend on it), before the customer
  if (sel.offeringId && addonGroupsFor(ctx, sel.offeringId).length > 0 &&
      (sel.addons === undefined || !groupRulesMet(ctx, sel.offeringId, sel.addons))) {
    return { step: "addons" };
  }
  return { step: (flow.then || ["customer"])[0] || "done" };
}

/**
 * After the customer changes `changed`, keep every other choice that is still possible and clear
 * the rest with a reason ("ทำสีผมไม่ว่างวันที่ 28"). The time is always cleared when the offering,
 * resource or date changes (design §5). Choosing the hours or head count after the time (a court:
 * time, then hours) keeps the time if it still fits, so the customer does not pick it twice.
 * Returns { selected, cleared: [{ step, value, reason }] }
 */
function reconcile(catalog, { selected, changed, now }) {
  const ctx = createContext(catalog, { now });
  const sel = normalizeSelected(ctx, selected);
  const cleared = [];
  if (["offering", "resource", "date"].includes(changed) && sel.time) {
    cleared.push({ step: "time", value: sel.time, reason: null });
    delete sel.time;
  }
  // Check each earlier choice against the new one and the choices already kept, in step order,
  // so a stylist who is off that day is dropped rather than the offering they were booked for.
  const kept = {};
  // (add-ons are checked last, so a new add-on that does not fit is dropped rather than the time)
  if (changed && SELECTED_KEY[changed] && changed !== "addons") kept[SELECTED_KEY[changed]] = sel[SELECTED_KEY[changed]];
  for (const step of STEP_ORDER) {
    const key = SELECTED_KEY[step];
    if (step === changed || sel[key] === undefined) continue;
    if (step === "resource" && sel[key] === null) {
      kept[key] = null;
      continue;
    }
    const { options, reason } = getOptions(catalog, { ask: step, selected: kept, now });
    const match = options.find((o) => o.value === sel[key]);
    if (match && match.available) {
      kept[key] = sel[key];
    } else if (step === "time") {
      // the time list holds only bookable times, so a missing one has no reason of its own
      cleared.push({ step, value: sel[key], reason: options.length ? null : reason });
    } else {
      cleared.push({ step, value: sel[key], reason: match ? match.reason : REASONS.NOT_OFFERED });
    }
  }
  // Add-ons belong to one offering; with a time they are checked one by one on top of the others
  if (sel.addons !== undefined) {
    if (changed === "offering" || !kept.offeringId) {
      for (const id of Object.keys(sel.addons)) cleared.push({ step: "addons", value: id, reason: null });
    } else if (!kept.time) {
      kept.addons = sel.addons; // checked again once a time is picked
    } else {
      const ctx2 = createContext(catalog, { now });
      const groups = addonGroupsFor(ctx2, kept.offeringId);
      const offered = new Map(groups.flatMap((g) => g.addons.map((a) => [a.id, { addon: a, group: g }])));
      const keptAddons = {};
      for (const [id, quantity] of Object.entries(sel.addons)) {
        const hit = offered.get(id);
        if (!hit || quantity > hit.addon.max_quantity) {
          cleared.push({ step: "addons", value: id, reason: REASONS.NOT_OFFERED });
          continue;
        }
        const inGroup = Object.keys(keptAddons).filter((k) => offered.get(k).group.id === hit.group.id).length;
        if (hit.group.max_select !== null && hit.group.max_select !== undefined && inGroup >= hit.group.max_select) {
          cleared.push({ step: "addons", value: id, reason: REASONS.ADDON_GROUP_RULE });
          continue;
        }
        const check = exists(ctx2, { ...kept, addons: { ...keptAddons, [id]: quantity } });
        if (check.available) keptAddons[id] = quantity;
        else cleared.push({ step: "addons", value: id, reason: hit.addon.uses_kind ? REASONS.RESOURCE_BUSY : REASONS.NOT_ENOUGH_TIME });
      }
      kept.addons = keptAddons;
    }
  }
  return { selected: kept, cleared };
}

module.exports = {
  REASONS,
  getOptions,
  nextStep,
  reconcile,
  // exported for create_booking (step 3) and tests
  evaluateDay,
  createContext,
  localToMs,
  msToLocal
};
