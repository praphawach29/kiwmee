// Client-safe capability catalog. These are flow presets, not business provisioning:
// never create/change offerings, resources, prices, hours or booking settings here.
function freeze(value) {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

const BOOKING_TEMPLATES = freeze([
  {
    id: "appointment", label: "นัดหมายบริการ", status: "existing_engine",
    description: "เลือกบริการและวันเวลา ใช้พนักงานที่ผูกกับบริการเดิม ไม่เพิ่มพนักงานหรือบริการให้ร้าน",
    capabilities: ["fixed_duration", "linked_staff"],
    limitation: "เป็นขั้นตอนจองเท่านั้น ไม่เปลี่ยนระยะเวลา ราคา หรือตารางพนักงาน"
  },
  {
    id: "resource_slot", label: "จองสนาม / ห้อง / อุปกรณ์", status: "existing_engine",
    description: "เลือกทรัพยากรที่บริการเดิมให้ลูกค้าเลือก แล้วเลือกวันเวลาและระยะเวลาถ้าบริการรองรับ",
    capabilities: ["customer_picks_resource", "linked_non_staff"],
    limitation: "จองช่วงเวลาในวันเดียว ไม่ใช่ระบบเช่ารับคืนข้ามวัน"
  },
  {
    id: "capacity_session", label: "จองตามความจุ / จำนวนคน", status: "existing_engine",
    description: "เลือกบริการ วันเวลา และจำนวนคน โดยหักความจุทรัพยากรตามจำนวนคนจริง",
    capabilities: ["party_size", "party_size_units", "shared_capacity"],
    limitation: "ใช้ช่องเวลาจากเวลาทำการเดิม ยังไม่มีตารางรอบคลาสหรือรายชื่อผู้เข้าร่วมแยกต่างหาก"
  },
  {
    id: "rental_range", label: "เช่าแบบรับ–คืน", status: "planned",
    description: "เลือกรับและคืนคนละวัน พร้อมวงจรการเช่า",
    capabilities: [],
    reason: "ยังไม่มีช่วงวันรับ–คืน สต็อกเช่า มัดจำ หรือสถานะรับคืนในระบบปัจจุบัน จึงใช้กับขั้นตอนจองเดิมไม่ได้"
  },
  {
    id: "service_visit", label: "บริการนอกสถานที่", status: "planned",
    description: "นัดหมายพร้อมสถานที่ให้บริการและการเดินทาง",
    capabilities: [],
    reason: "ยังไม่มีที่อยู่หน้างาน เขตให้บริการ เวลาเดินทาง หรือการจัดทีมในระบบปัจจุบัน จึงใช้กับขั้นตอนจองเดิมไม่ได้"
  }
]);

const active = (items) => (items || []).filter((item) => item.active !== false);

/** Pure, non-persisting preview using the camelCase dashboard catalog. */
function previewBookingTemplate(id, catalog = {}, currentFlow = catalog.flow) {
  const template = BOOKING_TEMPLATES.find((item) => item.id === id);
  const errors = [];
  const error = (code, message) => errors.push({ code, message });
  if (!template) error("UNKNOWN_TEMPLATE", "ไม่พบแบบขั้นตอนจองนี้");
  else if (template.status !== "existing_engine") error("PLANNED_TEMPLATE", template.reason);
  if (errors.length) return { template: template || null, applicable: false, errors, flow: null };

  const offerings = active(catalog.offerings);
  const resources = active(catalog.resources);
  const linked = (offering, kind) => resources.filter((r) => offering.resourceIds?.includes(r.id) && (!kind || r.kind === kind));
  if (!offerings.length) error("NO_ACTIVE_OFFERINGS", "ต้องมีบริการที่เปิดใช้ก่อน แบบขั้นตอนจองจะไม่สร้างบริการให้");
  for (const offering of offerings) {
    const requirements = offering.requirements || [];
    const validDuration = offering.durationMode === "fixed"
      ? Number.isInteger(offering.durationMinutes) && offering.durationMinutes > 0
      : offering.durationMode === "customer_choice" && Number.isInteger(offering.minMinutes) && offering.minMinutes > 0
        && Number.isInteger(offering.maxMinutes) && offering.maxMinutes >= offering.minMinutes
        && Number.isInteger(offering.stepMinutes) && offering.stepMinutes > 0;
    if (!validDuration) error("INVALID_DURATION", `“${offering.name}” ยังไม่มีระยะเวลาที่ใช้จองได้`);
    if (requirements.filter((r) => r.customerPicks).length > 1) {
      error("MULTIPLE_PICKED_KINDS", `“${offering.name}” ให้เลือกทรัพยากรหลายชนิด แต่หน้าจองปัจจุบันเลือกได้ครั้งละหนึ่งตัว ต้องปรับบริการก่อน`);
    }
    const pools = requirements.length ? requirements.map((r) => linked(offering, r.kind)) : [linked(offering)];
    if (pools.some((pool) => !pool.length)) error("MISSING_LINKED_RESOURCE", `“${offering.name}” ยังไม่มีทรัพยากรที่เปิดใช้ครบตามที่บริการต้องการ`);
  }
  const picks = offerings.some((o) => o.requirements?.some((r) => r.customerPicks));
  const require = ["offering", "date", "time"];
  const optional = picks ? ["resource"] : [];
  const flow = {
    entry: ["offering"], require, optional, then: ["customer"],
    options: { showAnyStaff: picks, dateRangeDays: currentFlow?.options?.dateRangeDays ?? null }
  };
  if (id === "appointment" && !offerings.some((o) => o.durationMode === "fixed" && o.requirements?.some((r) => r.kind === "staff" && linked(o, "staff").length))) {
    error("MISSING_APPOINTMENT_CAPABILITY", "ต้องมีบริการระยะเวลาคงที่ที่ใช้พนักงานซึ่งเปิดใช้และผูกกับบริการแล้ว");
  }
  if (id === "resource_slot") {
    const pickable = (o) => o.requirements?.some((r) => r.customerPicks && r.kind !== "staff" && linked(o, r.kind).length);
    if (!offerings.some(pickable)) error("MISSING_RESOURCE_PICK_CAPABILITY", "ต้องมีบริการที่ให้ลูกค้าเลือกสนาม ห้อง หรืออุปกรณ์ที่เปิดใช้และผูกกับบริการแล้ว");
    if (offerings.every(pickable) && offerings.length) flow.entry = ["resource"];
    require.push("resource");
    flow.optional = [];
    flow.options.showAnyStaff = false;
  }
  if (id === "capacity_session") {
    if (!offerings.some((o) => o.durationMode === "fixed" && o.maxPartySize > 1 && o.requirements?.some((r) => r.unitsPerBooking === "party_size" && linked(o, r.kind).some((resource) => resource.capacity >= o.maxPartySize)))) {
      error("MISSING_CAPACITY_CAPABILITY", "ต้องมีบริการระยะเวลาคงที่ที่รับหลายคน และหักความจุตามจำนวนคนจากทรัพยากรที่รองรับจำนวนคนสูงสุดของบริการได้");
    }
  }
  // Preserve every existing offering's required inputs, including mixed catalogs.
  if (offerings.some((o) => o.durationMode === "customer_choice")) require.push("duration");
  if (offerings.some((o) => o.maxPartySize > 1)) require.push("party");
  return { template, applicable: errors.length === 0, errors, flow: errors.length ? null : flow };
}

module.exports = { BOOKING_TEMPLATES, previewBookingTemplate };
