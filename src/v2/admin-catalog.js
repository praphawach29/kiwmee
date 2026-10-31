// The shop admin (design step 5): what an owner sets up — resources, offerings with their prices,
// opening hours and the booking flow — read and written for app/api/dashboard/*.
//
// Every query runs as role `authenticated` with the signed-in user's id (asUser), so the step 1 RLS
// policies are what keeps one shop out of another: members read, owners write. The checks here
// are for clear messages; the database refuses the same things on its own.
//
// Functions take a client that asUser (or a test) has already switched to the user, so tests run
// them inside rolled-back transactions.

const { AppError, badRequest, forbidden, notFound } = require("../errors");
const { validateMedia } = require("./media-validation");

const SHOP_KINDS = ["salon", "barber", "spa", "court", "other"];
const UNITS = ["per_booking", "per_hour", "per_person"];
const FLOW_STEPS = ["offering", "resource", "date", "time", "duration", "party"];
const ENTRY_STEPS = ["date", "offering", "resource"];
const OPTIONAL_STEPS = ["resource", "duration", "party"];

// ---------- running as the signed-in user ----------

async function actAs(client, user) {
  await client.query("set local role authenticated");
  await client.query("select set_config('request.jwt.claims', $1, true), set_config('request.jwt.claim.sub', $2, true)", [
    JSON.stringify({ sub: user.id, role: "authenticated", email: user.email ?? null }),
    user.id
  ]);
}

/** fn(client) in one transaction as `user` (role authenticated), committed when it returns. */
async function asUser(pool, user, fn) {
  const client = await pool.connect();
  let broken;
  try {
    await client.query("begin");
    await actAs(client, user);
    const result = await fn(client);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback").catch((e) => (broken = e));
    throw dbError(error);
  } finally {
    client.release(broken);
  }
}

// Database refusals as messages an owner can act on
function dbError(error) {
  if (error instanceof AppError) return error;
  switch (error?.code) {
    case "42501":
      return forbidden("ไม่มีสิทธิ์แก้ข้อมูลนี้ (เฉพาะเจ้าของร้าน)");
    case "23505":
      if (/businesses_slug/.test(error.constraint || "")) return new AppError("CONFLICT", "ชื่อลิงก์นี้มีร้านอื่นใช้แล้ว", 409);
      return new AppError("CONFLICT", "ข้อมูลซ้ำกับที่มีอยู่แล้ว", 409);
    case "23514":
    case "23502":
      return new AppError("INVALID", `ค่าที่กรอกไม่ถูกต้อง (${error.constraint || error.column || "check"})`, 422);
    case "23503":
      return new AppError("INVALID", "ข้อมูลที่อ้างถึงไม่มีอยู่ในร้านนี้", 422);
    case "22P02":
    case "22007":
    case "22008":
      return badRequest("รูปแบบข้อมูลไม่ถูกต้อง");
    default:
      return error;
  }
}

// ---------- input checks ----------

const invalid = (message) => new AppError("INVALID", message, 422);

function text(value, label, { max = 120, required = true } = {}) {
  if (value === undefined || value === null || (typeof value === "string" && value.trim() === "")) {
    if (required) throw invalid(`กรุณากรอก${label}`);
    return null;
  }
  if (typeof value !== "string") throw invalid(`${label}ต้องเป็นข้อความ`);
  const out = value.trim();
  if (out.length > max) throw invalid(`${label}ยาวเกิน ${max} ตัวอักษร`);
  return out;
}

function int(value, label, { min = 0, max = 100000, required = true } = {}) {
  if (value === undefined || value === null || value === "") {
    if (required) throw invalid(`กรุณากรอก${label}`);
    return null;
  }
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw invalid(`${label}ต้องเป็นจำนวนเต็ม ${min}–${max}`);
  return n;
}

function oneOf(value, allowed, label) {
  if (!allowed.includes(value)) throw invalid(`${label}ไม่ถูกต้อง`);
  return value;
}

// A kind of resource: one of the built-in ones (staff, court, room, equipment) or a name the shop
// gives its own ("เก้าอี้นวด"). Requirements match resources on this text.
function kindOf(value, label) {
  return text(value, label, { max: 40 });
}

function time(value, label) {
  if (typeof value !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) throw invalid(`${label}ต้องเป็นเวลา HH:MM`);
  return value;
}

function date(value, label = "วันที่") {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
    throw invalid(`${label}ต้องเป็นวันที่ YYYY-MM-DD`);
  }
  return value;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function uuid(value, label = "รหัส") {
  if (typeof value !== "string" || !UUID.test(value)) throw badRequest(`${label}ไม่ถูกต้อง`);
  return value;
}

function list(value, label) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 200) throw invalid(`${label}ต้องเป็นรายการ`);
  return value;
}

function bool(value) {
  return value === true;
}

// A start–end pair for a part of a day, or none for the whole day
function window(input, label) {
  if (input.isFullDay !== false) return { isFullDay: true, start: null, end: null };
  const start = time(input.start, `เวลาเริ่ม${label}`);
  const end = time(input.end, `เวลาสิ้นสุด${label}`);
  if (end <= start) throw invalid(`เวลาสิ้นสุด${label}ต้องหลังเวลาเริ่ม`);
  return { isFullDay: false, start, end };
}

const hhmm = (t) => (t === null || t === undefined ? null : String(t).slice(0, 5));

// ---------- shops ----------

async function listShops(client) {
  const { rows } = await client.query(
    `select b.slug, b.name, b.kind, m.role
       from public.businesses b
       join public.business_members m on m.business_id = b.id and m.user_id = auth.uid()
      order by b.name`
  );
  return rows;
}

async function createShop(client, input = {}) {
  const name = text(input.name, "ชื่อร้าน");
  const slug = text(input.slug, "ชื่อลิงก์", { max: 41 }).toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{1,40}$/.test(slug)) throw invalid("ชื่อลิงก์ใช้ได้เฉพาะ a-z 0-9 และ - (2–41 ตัว)");
  const kind = oneOf(input.kind ?? "salon", SHOP_KINDS, "ประเภทร้าน");
  await client.query("select public.create_business($1, $2, $3)", [name, slug, kind]);
  return { slug };
}

/** The shop with this slug if the user belongs to it (else 404); owner: true also requires owner. */
async function memberShop(client, slug, { owner = false } = {}) {
  if (typeof slug !== "string" || !/^[a-z0-9][a-z0-9-]{1,40}$/.test(slug)) throw notFound("ไม่พบร้าน");
  const { rows } = await client.query(
    `select b.id, b.slug, b.name, b.kind, b.timezone, m.role
       from public.businesses b
       join public.business_members m on m.business_id = b.id and m.user_id = auth.uid()
      where b.slug = $1`,
    [slug]
  );
  if (!rows[0]) throw notFound("ไม่พบร้าน หรือคุณไม่ได้เป็นสมาชิกของร้านนี้");
  if (owner && rows[0].role !== "owner") throw forbidden("เฉพาะเจ้าของร้านแก้ข้อมูลได้");
  return rows[0];
}

/** Everything the admin page edits, for one shop. */
async function getCatalog(client, shop) {
  const queries = [
    "select name, kind, media from public.businesses where id = $1",
    `select min_lead_minutes, slot_interval_minutes, max_advance_days, hold_minutes,
            customer_can_cancel, customer_can_reschedule, customer_change_cutoff_hours
       from public.business_booking_settings where business_id = $1`,
    "select day_of_week, is_open, open_time, close_time from public.business_hours where business_id = $1",
    `select id, date::text as date, is_full_day, start_time, end_time, reason from public.business_closures
        where business_id = $1 and date >= current_date - 1 order by date, start_time nulls first`,
    "select id, kind, name, capacity, sort_order, active from public.resources where business_id = $1 order by active desc, sort_order, name",
    "select resource_id, day_of_week, is_working, start_time, end_time from public.resource_schedules where business_id = $1",
    `select id, resource_id, date::text as date, is_full_day, start_time, end_time, reason from public.resource_time_off
        where business_id = $1 and date >= current_date - 1 order by date, start_time nulls first`,
    `select id, category, name, description, duration_mode, duration_minutes, min_minutes, max_minutes, step_minutes,
              buffer_after_minutes, max_party_size, sort_order, active, media
         from public.offerings where business_id = $1 order by active desc, sort_order, name`,
    "select offering_id, kind, customer_picks, units_per_booking from public.offering_requirements where business_id = $1 order by kind",
    "select offering_id, resource_id from public.offering_resources where business_id = $1",
    `select id, offering_id, unit, amount::float8 as amount, days_of_week, start_time, end_time, priority
         from public.price_rules where business_id = $1 order by priority, start_time nulls first, id`,
    "select entry, require, optional, \"then\", options from public.booking_flows where business_id = $1 and category is null"
  ];

  // one client runs one query at a time
  const results = [];
  for (const sql of queries) results.push((await client.query(sql, [shop.id])).rows);
  const [[current], settings, hours, closures, resources, schedules, timeOff, offerings, requirements, links, prices, flows] = results;

  const s = settings[0] ?? {
    min_lead_minutes: 15,
    slot_interval_minutes: 15,
    max_advance_days: 30,
    hold_minutes: 10,
    customer_can_cancel: true,
    customer_can_reschedule: true,
    customer_change_cutoff_hours: 2
  };
  const flow = flows[0] ?? { entry: ["date", "offering"], require: ["offering", "date", "time"], optional: ["resource"], then: ["customer"], options: {} };
  // A shop with no hours saved yet is open 10–19 every day (as the options engine assumes)
  const dayHours = (d) => hours.find((h) => h.day_of_week === d) ?? (hours.length ? null : { is_open: true, open_time: "10:00", close_time: "19:00" });

  return {
    shop: { slug: shop.slug, name: current.name, kind: current.kind, timezone: shop.timezone, role: shop.role, media: current.media },
    settings: {
      minLeadMinutes: s.min_lead_minutes,
      slotIntervalMinutes: s.slot_interval_minutes,
      maxAdvanceDays: s.max_advance_days,
      holdMinutes: s.hold_minutes,
      customerCanCancel: s.customer_can_cancel,
      customerCanReschedule: s.customer_can_reschedule,
      customerChangeCutoffHours: s.customer_change_cutoff_hours
    },
    hours: [0, 1, 2, 3, 4, 5, 6].map((d) => {
      const h = dayHours(d);
      return { dayOfWeek: d, isOpen: Boolean(h?.is_open), open: hhmm(h?.open_time) ?? "10:00", close: hhmm(h?.close_time) ?? "19:00" };
    }),
    closures: closures.map((c) => ({ id: c.id, date: c.date, isFullDay: c.is_full_day, start: hhmm(c.start_time), end: hhmm(c.end_time), reason: c.reason })),
    resources: resources.map((r) => ({
      id: r.id,
      kind: r.kind,
      name: r.name,
      capacity: r.capacity,
      sortOrder: r.sort_order,
      active: r.active,
      // no row for a day = works the shop's hours that day
      schedule: [0, 1, 2, 3, 4, 5, 6].map((d) => {
        const row = schedules.find((x) => x.resource_id === r.id && x.day_of_week === d);
        return row
          ? { dayOfWeek: d, isWorking: row.is_working, start: hhmm(row.start_time), end: hhmm(row.end_time), custom: true }
          : { dayOfWeek: d, isWorking: true, start: null, end: null, custom: false };
      }),
      offeringIds: links.filter((l) => l.resource_id === r.id).map((l) => l.offering_id)
    })),
    timeOff: timeOff.map((t) => ({
      id: t.id,
      resourceId: t.resource_id,
      date: t.date,
      isFullDay: t.is_full_day,
      start: hhmm(t.start_time),
      end: hhmm(t.end_time),
      reason: t.reason
    })),
    offerings: offerings.map((o) => ({
      id: o.id,
      category: o.category,
      name: o.name,
      description: o.description,
      media: o.media,
      durationMode: o.duration_mode,
      durationMinutes: o.duration_minutes,
      minMinutes: o.min_minutes,
      maxMinutes: o.max_minutes,
      stepMinutes: o.step_minutes,
      bufferAfterMinutes: o.buffer_after_minutes,
      maxPartySize: o.max_party_size,
      sortOrder: o.sort_order,
      active: o.active,
      requirements: requirements
        .filter((q2) => q2.offering_id === o.id)
        .map((q2) => ({ kind: q2.kind, customerPicks: q2.customer_picks, unitsPerBooking: q2.units_per_booking })),
      resourceIds: links.filter((l) => l.offering_id === o.id).map((l) => l.resource_id),
      prices: prices
        .filter((p) => p.offering_id === o.id)
        .map((p) => ({
          unit: p.unit,
          amount: p.amount,
          daysOfWeek: p.days_of_week,
          start: hhmm(p.start_time),
          end: hhmm(p.end_time),
          priority: p.priority
        }))
    })),
    flow: {
      entry: flow.entry,
      require: flow.require,
      optional: flow.optional,
      then: flow.then,
      options: { showAnyStaff: Boolean(flow.options?.show_any_staff), dateRangeDays: flow.options?.date_range_days ?? null }
    }
  };
}

/** Name, type, booking rules and opening hours. */
async function saveShop(client, shop, input = {}) {
  const name = text(input.name, "ชื่อร้าน");
  const kind = oneOf(input.kind ?? shop.kind, SHOP_KINDS, "ประเภทร้าน");
  const media = validateMedia(input.media);
  // SQL NULL means omitted; an explicit [] clears the gallery. No read/write race.
  await client.query("update public.businesses set name = $2, kind = $3, media = coalesce($4::jsonb, media) where id = $1",
    [shop.id, name, kind, media === undefined ? null : JSON.stringify(media)]);

  if (input.settings !== undefined) {
    const s = input.settings ?? {};
    const values = [
      int(s.minLeadMinutes, "จองล่วงหน้าอย่างน้อย (นาที)", { min: 0, max: 10080 }),
      int(s.slotIntervalMinutes, "ช่วงเวลาเริ่ม (นาที)", { min: 5, max: 240 }),
      int(s.maxAdvanceDays, "เปิดให้จองล่วงหน้า (วัน)", { min: 1, max: 365 }),
      int(s.holdMinutes ?? 10, "เวลากันคิวรอชำระเงิน (นาที)", { min: 1, max: 1440 }),
      s.customerCanCancel !== false,
      s.customerCanReschedule !== false,
      int(s.customerChangeCutoffHours ?? 2, "ลูกค้าเปลี่ยนเองได้ถึงก่อนนัด (ชั่วโมง)", { min: 0, max: 720 })
    ];
    await client.query(
      `insert into public.business_booking_settings (business_id, min_lead_minutes, slot_interval_minutes, max_advance_days, hold_minutes,
                                                     customer_can_cancel, customer_can_reschedule, customer_change_cutoff_hours)
       values ($1, $2, $3, $4, $5, $6, $7, $8)
       on conflict (business_id) do update set min_lead_minutes = excluded.min_lead_minutes,
         slot_interval_minutes = excluded.slot_interval_minutes, max_advance_days = excluded.max_advance_days,
         hold_minutes = excluded.hold_minutes, customer_can_cancel = excluded.customer_can_cancel,
         customer_can_reschedule = excluded.customer_can_reschedule,
         customer_change_cutoff_hours = excluded.customer_change_cutoff_hours`,
      [shop.id, ...values]
    );
  }

  if (input.hours !== undefined) {
    const hours = list(input.hours, "เวลาทำการ");
    if (hours.length !== 7) throw invalid("เวลาทำการต้องครบ 7 วัน");
    const days = hours.map((h) => {
      const day = int(h?.dayOfWeek, "วัน", { min: 0, max: 6 });
      const open = time(h.open, "เวลาเปิด");
      const close = time(h.close, "เวลาปิด");
      if (close <= open) throw invalid("เวลาปิดต้องหลังเวลาเปิด");
      return [day, bool(h.isOpen), open, close];
    });
    if (new Set(days.map((d) => d[0])).size !== 7) throw invalid("เวลาทำการต้องครบ 7 วัน");
    for (const [day, isOpen, open, close] of days) {
      await client.query(
        `insert into public.business_hours (business_id, day_of_week, is_open, open_time, close_time) values ($1, $2, $3, $4, $5)
         on conflict (business_id, day_of_week) do update set is_open = excluded.is_open, open_time = excluded.open_time, close_time = excluded.close_time`,
        [shop.id, day, isOpen, open, close]
      );
    }
  }
}

// ---------- resources ----------

/** Create (id null) or change a resource, its weekly schedule and the offerings it does. */
async function saveResource(client, shop, id, input = {}) {
  const kind = kindOf(input.kind, "ชนิด");
  const name = text(input.name, "ชื่อ");
  const capacity = int(input.capacity ?? 1, "ความจุ", { min: 1, max: 1000 });
  const sortOrder = int(input.sortOrder ?? 0, "ลำดับ", { min: -1000, max: 1000 });
  const active = input.active !== false;

  let resourceId = id;
  if (id) {
    uuid(id);
    const { rowCount } = await client.query(
      "update public.resources set kind = $3, name = $4, capacity = $5, sort_order = $6, active = $7 where id = $1 and business_id = $2",
      [id, shop.id, kind, name, capacity, sortOrder, active]
    );
    if (!rowCount) throw notFound("ไม่พบรายการนี้");
  } else {
    const { rows } = await client.query(
      "insert into public.resources (business_id, kind, name, capacity, sort_order, active) values ($1, $2, $3, $4, $5, $6) returning id",
      [shop.id, kind, name, capacity, sortOrder, active]
    );
    resourceId = rows[0].id;
  }

  const schedule = list(input.schedule, "ตารางงาน");
  if (schedule !== undefined) {
    await client.query("delete from public.resource_schedules where resource_id = $1 and business_id = $2", [resourceId, shop.id]);
    for (const day of schedule) {
      // a day left as "the shop's hours" keeps no row
      if (day?.custom === false) continue;
      const dow = int(day?.dayOfWeek, "วัน", { min: 0, max: 6 });
      const isWorking = day.isWorking !== false;
      const start = isWorking ? time(day.start, "เวลาเริ่มงาน") : "00:00";
      const end = isWorking ? time(day.end, "เวลาเลิกงาน") : "23:59";
      if (end <= start) throw invalid("เวลาเลิกงานต้องหลังเวลาเริ่มงาน");
      await client.query(
        "insert into public.resource_schedules (business_id, resource_id, day_of_week, is_working, start_time, end_time) values ($1, $2, $3, $4, $5, $6)",
        [shop.id, resourceId, dow, isWorking, start, end]
      );
    }
  }

  const offeringIds = list(input.offeringIds, "บริการ");
  if (offeringIds !== undefined) {
    offeringIds.forEach((o) => uuid(o, "รหัสบริการ"));
    await client.query("delete from public.offering_resources where resource_id = $1 and business_id = $2", [resourceId, shop.id]);
    await client.query(
      `insert into public.offering_resources (business_id, offering_id, resource_id)
       select $1, o, $2 from unnest($3::uuid[]) o on conflict do nothing`,
      [shop.id, resourceId, [...new Set(offeringIds)]]
    );
  }
  return { id: resourceId };
}

// A row that bookings still point at cannot go; it is switched off instead, so history keeps its name
async function removeOrArchive(client, table, shop, id) {
  uuid(id);
  await client.query("savepoint remove_row");
  try {
    const { rowCount } = await client.query(`delete from public.${table} where id = $1 and business_id = $2`, [id, shop.id]);
    if (!rowCount) throw notFound("ไม่พบรายการนี้");
    await client.query("release savepoint remove_row");
    return { removed: true, archived: false };
  } catch (error) {
    if (error?.code !== "23503") throw error;
    await client.query("rollback to savepoint remove_row");
    await client.query(`update public.${table} set active = false where id = $1 and business_id = $2`, [id, shop.id]);
    return { removed: false, archived: true };
  }
}

const deleteResource = (client, shop, id) => removeOrArchive(client, "resources", shop, id);

// ---------- offerings and prices ----------

function offeringRow(input) {
  const durationMode = oneOf(input.durationMode ?? "fixed", ["fixed", "customer_choice"], "แบบระยะเวลา");
  const row = {
    category: text(input.category, "หมวด", { max: 60, required: false }),
    name: text(input.name, "ชื่อบริการ"),
    description: text(input.description, "รายละเอียด", { max: 500, required: false }),
    durationMode,
    durationMinutes: null,
    minMinutes: null,
    maxMinutes: null,
    stepMinutes: null,
    bufferAfterMinutes: int(input.bufferAfterMinutes ?? 0, "เวลาพักหลังจบ (นาที)", { min: 0, max: 480 }),
    maxPartySize: int(input.maxPartySize ?? 1, "จำนวนคนสูงสุดต่อการจอง", { min: 1, max: 1000 }),
    sortOrder: int(input.sortOrder ?? 0, "ลำดับ", { min: -1000, max: 1000 }),
    active: input.active !== false
  };
  if (durationMode === "fixed") {
    row.durationMinutes = int(input.durationMinutes, "ระยะเวลา (นาที)", { min: 5, max: 1440 });
  } else {
    row.minMinutes = int(input.minMinutes, "ระยะเวลาต่ำสุด (นาที)", { min: 5, max: 1440 });
    row.maxMinutes = int(input.maxMinutes, "ระยะเวลาสูงสุด (นาที)", { min: row.minMinutes, max: 1440 });
    row.stepMinutes = int(input.stepMinutes, "เพิ่มทีละ (นาที)", { min: 5, max: 1440 });
  }
  return row;
}

function priceRow(p, i) {
  const label = ` (ราคาแถว ${i + 1})`;
  const unit = oneOf(p?.unit, UNITS, `หน่วยราคา${label}`);
  const amount = Number(p.amount);
  if (!Number.isFinite(amount) || amount < 0 || amount > 10000000) throw invalid(`ราคาต้องเป็นตัวเลขไม่ติดลบ${label}`);
  let days = null;
  if (p.daysOfWeek !== null && p.daysOfWeek !== undefined) {
    if (!Array.isArray(p.daysOfWeek) || p.daysOfWeek.length === 0) throw invalid(`เลือกวันอย่างน้อย 1 วัน${label}`);
    days = [...new Set(p.daysOfWeek.map((d) => int(d, `วัน${label}`, { min: 0, max: 6 })))].sort();
    if (days.length === 7) days = null;
  }
  let start = null;
  let end = null;
  if (p.start || p.end) {
    start = time(p.start, `เวลาเริ่ม${label}`);
    end = time(p.end, `เวลาสิ้นสุด${label}`);
    if (end <= start) throw invalid(`เวลาสิ้นสุดต้องหลังเวลาเริ่ม${label}`);
  }
  // a rule limited to some days or hours wins over the all-day price unless the owner says otherwise
  const priority = p.priority === undefined || p.priority === null || p.priority === ""
    ? (days ? 1 : 0) + (start ? 1 : 0)
    : int(p.priority, `ลำดับความสำคัญ${label}`, { min: -100, max: 100 });
  return { unit, amount: Math.round(amount * 100) / 100, days, start, end, priority };
}

/** Create (id null) or change an offering with its requirements, resources and price rules. */
async function saveOffering(client, shop, id, input = {}) {
  const o = offeringRow(input);
  const media = validateMedia(input.media);
  const values = [o.category, o.name, o.description, o.durationMode, o.durationMinutes, o.minMinutes, o.maxMinutes, o.stepMinutes,
    o.bufferAfterMinutes, o.maxPartySize, o.sortOrder, o.active, media === undefined ? null : JSON.stringify(media)];

  let offeringId = id;
  if (id) {
    uuid(id);
    const { rowCount } = await client.query(
      `update public.offerings set category = $3, name = $4, description = $5, duration_mode = $6, duration_minutes = $7,
              min_minutes = $8, max_minutes = $9, step_minutes = $10, buffer_after_minutes = $11, max_party_size = $12,
              sort_order = $13, active = $14, media = coalesce($15::jsonb, media)
        where id = $1 and business_id = $2`,
      [id, shop.id, ...values]
    );
    if (!rowCount) throw notFound("ไม่พบบริการนี้");
  } else {
    const { rows } = await client.query(
      `insert into public.offerings (business_id, category, name, description, duration_mode, duration_minutes, min_minutes, max_minutes,
              step_minutes, buffer_after_minutes, max_party_size, sort_order, active, media)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, coalesce($14::jsonb, '[]'::jsonb)) returning id`,
      [shop.id, ...values]
    );
    offeringId = rows[0].id;
  }

  const requirements = list(input.requirements, "ทรัพยากรที่ต้องใช้");
  if (requirements !== undefined) {
    const rows = requirements.map((r) => ({
      kind: kindOf(r?.kind, "ชนิดทรัพยากรที่ต้องใช้"),
      customerPicks: bool(r.customerPicks),
      unitsPerBooking: oneOf(r.unitsPerBooking ?? "one", ["one", "party_size"], "จำนวนที่ใช้ต่อการจอง")
    }));
    if (new Set(rows.map((r) => r.kind)).size !== rows.length) throw invalid("ชนิดทรัพยากรที่ต้องใช้ซ้ำกัน");
    await client.query("delete from public.offering_requirements where offering_id = $1 and business_id = $2", [offeringId, shop.id]);
    for (const r of rows) {
      await client.query(
        "insert into public.offering_requirements (business_id, offering_id, kind, customer_picks, units_per_booking) values ($1, $2, $3, $4, $5)",
        [shop.id, offeringId, r.kind, r.customerPicks, r.unitsPerBooking]
      );
    }
  }

  const resourceIds = list(input.resourceIds, "ทรัพยากร");
  if (resourceIds !== undefined) {
    resourceIds.forEach((r) => uuid(r, "รหัสทรัพยากร"));
    await client.query("delete from public.offering_resources where offering_id = $1 and business_id = $2", [offeringId, shop.id]);
    await client.query(
      `insert into public.offering_resources (business_id, offering_id, resource_id)
       select $1, $2, r from unnest($3::uuid[]) r on conflict do nothing`,
      [shop.id, offeringId, [...new Set(resourceIds)]]
    );
  }

  const prices = list(input.prices, "ราคา");
  if (prices !== undefined) {
    const rows = prices.map(priceRow);
    await client.query("delete from public.price_rules where offering_id = $1 and business_id = $2", [offeringId, shop.id]);
    for (const p of rows) {
      await client.query(
        `insert into public.price_rules (business_id, offering_id, unit, amount, days_of_week, start_time, end_time, priority)
         values ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [shop.id, offeringId, p.unit, p.amount, p.days, p.start, p.end, p.priority]
      );
    }
  }
  return { id: offeringId };
}

const deleteOffering = (client, shop, id) => removeOrArchive(client, "offerings", shop, id);

// ---------- days off ----------

async function addClosure(client, shop, input = {}) {
  const w = window(input, "");
  const { rows } = await client.query(
    `insert into public.business_closures (business_id, date, is_full_day, start_time, end_time, reason)
     values ($1, $2, $3, $4, $5, $6) returning id`,
    [shop.id, date(input.date), w.isFullDay, w.start, w.end, text(input.reason, "เหตุผล", { max: 200, required: false })]
  );
  return { id: rows[0].id };
}

async function deleteClosure(client, shop, id) {
  const { rowCount } = await client.query("delete from public.business_closures where id = $1 and business_id = $2", [uuid(id), shop.id]);
  if (!rowCount) throw notFound("ไม่พบรายการนี้");
  return { removed: true };
}

async function addTimeOff(client, shop, input = {}) {
  const w = window(input, "");
  const { rows } = await client.query(
    `insert into public.resource_time_off (business_id, resource_id, date, is_full_day, start_time, end_time, reason)
     values ($1, $2, $3, $4, $5, $6, $7) returning id`,
    [shop.id, uuid(input.resourceId, "รหัสทรัพยากร"), date(input.date), w.isFullDay, w.start, w.end,
      text(input.reason, "เหตุผล", { max: 200, required: false })]
  );
  return { id: rows[0].id };
}

async function deleteTimeOff(client, shop, id) {
  const { rowCount } = await client.query("delete from public.resource_time_off where id = $1 and business_id = $2", [uuid(id), shop.id]);
  if (!rowCount) throw notFound("ไม่พบรายการนี้");
  return { removed: true };
}

// ---------- booking flow ----------

function steps(value, allowed, label) {
  if (!Array.isArray(value)) throw invalid(`${label}ต้องเป็นรายการ`);
  const out = [...new Set(value)];
  for (const s of out) if (!allowed.includes(s)) throw invalid(`${label}มีขั้นที่ใช้ไม่ได้: ${s}`);
  return out;
}

/** The shop's default flow (design §5). Same rules as the booking_flows checks, in words. */
function checkFlow(input = {}) {
  const entry = steps(input.entry, ENTRY_STEPS, "ทางเริ่ม");
  const require = steps(input.require, FLOW_STEPS, "ขั้นที่ต้องเลือก");
  const optional = steps(input.optional ?? [], OPTIONAL_STEPS, "ขั้นที่เลือกหรือไม่ก็ได้");
  const then = steps(input.then ?? ["customer"], ["customer", "payment"], "ขั้นหลังเลือกครบ");
  if (entry.length === 0) throw invalid("ต้องมีทางเริ่มอย่างน้อย 1 ทาง");
  for (const s of ["offering", "date", "time"]) {
    if (!require.includes(s)) throw invalid("ลูกค้าต้องเลือกบริการ วันที่ และเวลาเสมอ");
  }
  if (require.some((s) => optional.includes(s))) throw invalid("ขั้นหนึ่งเป็นได้ทั้ง “ต้องเลือก” หรือ “เลือกหรือไม่ก็ได้” อย่างใดอย่างหนึ่ง");
  if (entry.some((s) => !require.includes(s) && !optional.includes(s))) throw invalid("ทางเริ่มต้องเป็นขั้นที่ลูกค้าเลือกอยู่แล้ว");
  if (!then.includes("customer")) throw invalid("ต้องมีขั้นกรอกข้อมูลลูกค้า");
  // The page has no payment step yet: a "payment" flow would hold every booking and let it expire
  if (then.includes("payment")) throw invalid("ยังไม่เปิดขั้นชำระเงิน (ขั้นที่ 6)");
  const opts = input.options ?? {};
  const dateRangeDays = opts.dateRangeDays === null || opts.dateRangeDays === undefined || opts.dateRangeDays === ""
    ? null
    : int(opts.dateRangeDays, "จำนวนวันในปฏิทิน", { min: 1, max: 365 });
  return { entry, require, optional, then, options: { show_any_staff: bool(opts.showAnyStaff), date_range_days: dateRangeDays } };
}

async function saveFlow(client, shop, input) {
  const f = checkFlow(input);
  const options = Object.fromEntries(Object.entries(f.options).filter(([, v]) => v !== null));
  const removed = Object.keys(f.options).filter((k) => f.options[k] === null);
  const values = [shop.id, f.entry, f.require, f.optional, f.then, JSON.stringify(options), removed];
  // keep option keys this page does not edit
  const { rowCount } = await client.query(
    `update public.booking_flows set entry = $2, require = $3, optional = $4, "then" = $5, options = (options || $6::jsonb) - $7::text[]
      where business_id = $1 and category is null`,
    values
  );
  if (!rowCount) {
    await client.query(
      `insert into public.booking_flows (business_id, entry, require, optional, "then", options) values ($1, $2, $3, $4, $5, $6::jsonb)`,
      values.slice(0, 6)
    );
  }
}

module.exports = {
  asUser,
  actAs,
  dbError,
  listShops,
  createShop,
  memberShop,
  getCatalog,
  saveShop,
  saveResource,
  deleteResource,
  saveOffering,
  deleteOffering,
  addClosure,
  deleteClosure,
  addTimeOff,
  deleteTimeOff,
  checkFlow,
  saveFlow
};
