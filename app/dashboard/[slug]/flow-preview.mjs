// What a customer will walk through for a booking flow (design §5), worked out from the flow and
// the shop's catalog so the owner sees it before saving. Mirrors nextStep in src/v2/options-engine.js:
// the starting step, then the remaining steps in STEP_ORDER, then `then`; a step that does not apply
// to the chosen offering is skipped there, which this says in a note.

export const STEP_ORDER = ["offering", "resource", "date", "time", "duration", "party"];
export const KIND_WORD = { staff: "ช่าง", court: "สนาม", room: "ห้อง", equipment: "อุปกรณ์" };
export const STEP_WORD = {
  offering: "เลือกบริการ",
  resource: "เลือกช่าง/สนาม",
  date: "เลือกวัน",
  time: "เลือกเวลาเริ่ม",
  duration: "เลือกระยะเวลา",
  party: "เลือกจำนวนคน",
  customer: "กรอกชื่อ เบอร์โทร",
  payment: "ชำระเงิน"
};

const active = (list) => list.filter((x) => x.active !== false);

// The kinds customers pick themselves, and how many offerings let them
function pickInfo(catalog) {
  const offerings = active(catalog.offerings);
  const picking = offerings.filter((o) => o.requirements.some((r) => r.customerPicks));
  const kinds = [...new Set(picking.flatMap((o) => o.requirements.filter((r) => r.customerPicks).map((r) => r.kind)))];
  return { offerings, picking, kinds };
}

export function resourceWord(catalog) {
  const { kinds } = pickInfo(catalog);
  return kinds.length ? kinds.map((k) => KIND_WORD[k]).join("/") : "ช่าง";
}

/** [{ entry, steps: [{ step, label, optional, note }] }] — one path per way in */
export function previewPaths(flow, catalog) {
  const { offerings, picking } = pickInfo(catalog);
  const word = resourceWord(catalog);
  const chosen = [...flow.require, ...flow.optional];
  const choiceDurations = offerings.filter((o) => o.durationMode === "customer_choice");
  const groups = offerings.filter((o) => o.maxPartySize > 1);

  function describe(step) {
    const label = step === "resource" ? `เลือก${word}` : STEP_WORD[step];
    let note = null;
    if (step === "resource") {
      if (!picking.length) note = "ข้ามเสมอ: ไม่มีบริการไหนให้ลูกค้าเลือกเอง (ระบบเลือกตัวที่ว่างให้)";
      else if (picking.length < offerings.length) note = `เฉพาะบริการที่ให้ลูกค้าเลือก${word} (${picking.length}/${offerings.length})`;
      if (flow.optional.includes("resource") && flow.options.showAnyStaff && picking.length) note = [note, "มีปุ่ม “ใครก็ได้”"].filter(Boolean).join(" · ");
    }
    if (step === "duration") {
      if (!choiceDurations.length) note = "ข้ามเสมอ: ไม่มีบริการที่ให้ลูกค้าเลือกระยะเวลา";
      else if (choiceDurations.length < offerings.length) note = "เฉพาะบริการที่ให้เลือกระยะเวลา";
    }
    if (step === "party") {
      if (!groups.length) note = "ข้ามเสมอ: ทุกบริการจองได้ทีละ 1 คน";
      else if (groups.length < offerings.length) note = "เฉพาะบริการที่จองได้หลายคน";
    }
    return { step, label, optional: flow.optional.includes(step), note };
  }

  return flow.entry.map((entry) => ({
    entry,
    steps: [
      describe(entry),
      ...STEP_ORDER.filter((s) => s !== entry && chosen.includes(s)).map(describe),
      ...flow.then.map((s) => ({ step: s, label: STEP_WORD[s], optional: false, note: null }))
    ]
  }));
}

/** Problems that would stop customers from booking, or surprise the owner */
export function catalogWarnings(flow, catalog) {
  const out = [];
  const { offerings, picking } = pickInfo(catalog);
  const resources = active(catalog.resources);
  if (!offerings.length) out.push("ยังไม่มีบริการที่เปิดใช้ ลูกค้ายังจองไม่ได้");
  for (const o of offerings) {
    if (!o.prices.length) out.push(`“${o.name}” ยังไม่มีราคา (จะแสดงเป็น 0 บาท)`);
    const kinds = o.requirements.length ? o.requirements.map((r) => r.kind) : [];
    if (!kinds.length && !o.resourceIds.length) out.push(`“${o.name}” ยังไม่ได้ระบุว่าใช้ช่าง/สนามอะไร ลูกค้าจองไม่ได้`);
    for (const kind of kinds) {
      const usable = resources.filter((r) => r.kind === kind && o.resourceIds.includes(r.id));
      if (!usable.length) out.push(`“${o.name}” ต้องใช้${KIND_WORD[kind]} แต่ยังไม่มี${KIND_WORD[kind]}ที่ทำบริการนี้ ลูกค้าจองไม่ได้`);
    }
  }
  if (picking.length && !flow.require.includes("resource") && !flow.optional.includes("resource")) {
    out.push(`บางบริการให้ลูกค้าเลือก${resourceWord(catalog)}เอง แต่ขั้นตอนจองไม่มีขั้นนี้ ระบบจะเลือกตัวที่ว่างให้`);
  }
  const choosesDuration = flow.require.includes("duration") || flow.optional.includes("duration");
  for (const o of offerings.filter((x) => x.durationMode === "customer_choice")) {
    if (!choosesDuration) out.push(`“${o.name}” ให้ลูกค้าเลือกระยะเวลา แต่ขั้นตอนจองไม่มีขั้นเลือกระยะเวลา ลูกค้าจองไม่ได้`);
  }
  if (flow.entry.includes("resource") && !picking.length) {
    out.push(`ทางเริ่ม “เลือก${resourceWord(catalog)}” ใช้ไม่ได้ เพราะไม่มีบริการไหนให้ลูกค้าเลือกเอง`);
  }
  return out;
}
