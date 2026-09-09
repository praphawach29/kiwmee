const { randomUUID } = require("node:crypto");
const { MockAIProvider } = require("./provider");
const { getBookingConfig } = require("../config");
const { normalizePhone } = require("../security/access");
const { logEvent } = require("../observability/logger");

class Receptionist {
  constructor(gateway, provider = new MockAIProvider(), handoffService = null) {
    this.gateway = gateway; this.provider = provider; this.handoffService = handoffService;
  }
  async respond(session, message) {
    let choices = []; let text = "กรุณาเลือกบริการ หรือพิมพ์ ดูนัด ตามด้วยรหัสนัดและเบอร์โทร";
    const call = async (name, input, context = {}) => {
      const result = await this.gateway.execute(name, input, { session, ...context });
      if (!result.ok) { const error = new Error(result.error.message); error.code = result.error.code; throw error; }
      return result.data;
    };
    const slots = async () => {
      session.slot = null; session.pending = null;
      session.slots = await call("check_availability", { service_id: session.service.id, staff_id: session.staff?.id ?? null, date: session.date });
      session.stage = "slot";
      choices = session.slots.map((slot) => ({ label: `${formatTime(slot.start_at)} · ${session.staffList.find((s) => s.id === slot.staff_id)?.name ?? "ช่าง"}`, value: `${slot.staff_id} ${slot.start_at}` }));
      text = choices.length ? "เลือกเวลาที่ต้องการค่ะ" : "วันนี้ไม่มีเวลาว่าง กรุณาเลือกวันอื่น";
      if (!choices.length) session.stage = "date";
    };
    const review = () => {
      session.pending = { id: randomUUID(), action: session.action, expires: Date.now() + 10 * 60 * 1000,
        draft: structuredClone({ service: session.service, staff: session.staff, slot: session.slot, customer: session.customer, booking: session.booking }) };
      session.stage = "review";
      text = "กรุณาตรวจสอบรายละเอียด แล้วกดยืนยันเพื่อดำเนินการค่ะ";
    };
    try {
      // User text can request handoff, but neither user text nor provider output grants permissions.
      const sensitive = /ร้องเรียน|ส่วนลด|ลดราคา|ยกเว้น|คุยกับคน|คุยกับพนักงาน|complaint|discount|exception|human/i.test(message);
      const directSlot = session.stage === "slot" && session.slots?.find((s) =>
        `${s.staff_id} ${s.start_at}` === message.trim() ||
        s.start_at === message.trim() ||
        formatTime(s.start_at) === message.trim() ||
        `${formatTime(s.start_at)} · ${session.staffList?.find((st) => st.id === s.staff_id)?.name ?? "ช่าง"}` === message.trim()
      );
      const hasDate = /พรุ่งนี้|วันนี้|\d{4}-\d{2}-\d{2}/.test(message.trim());
      const directService = !hasDate && session.stage === "service" && Array.isArray(session.services) && session.services.length
        ? matchOption(session.services, message.trim())
        : null;
      const directStaff = !hasDate && session.stage === "staff" && Array.isArray(session.staffList) && session.staffList.length
        ? matchStaff(session.staffList, message.trim())
        : null;
      const plan = sensitive ? { intent: "handoff" }
        : directSlot ? { intent: "slot", value: `${directSlot.staff_id} ${directSlot.start_at}` }
        : (directService && directService.match) ? { intent: "service", value: directService.match.name }
        : (directStaff && directStaff.match) ? { intent: "staff", value: directStaff.match.name }
        : (directStaff && directStaff.isAny) ? { intent: "staff", value: "ใครก็ได้" }
        : await this.provider.interpret({ message, state: {
            stage: session.stage,
            services: session.services?.map((item) => item.name) ?? [],
            staff: session.staffList?.map((item) => item.name) ?? []
          } });
      if (!plan || typeof plan.intent !== "string" || Object.keys(plan).some((key) => !["intent", "value"].includes(key))) throw new Error("Invalid provider response");
      if (plan.intent === "handoff") {
        session.handoff = true; session.pending = null;
        if (this.handoffService) await this.handoffService.create(session, handoffReason(message));
        text = this.handoffService ? "รับเรื่องไว้แล้วค่ะ พนักงานจะรับช่วงต่อผ่านช่องทางติดต่อของร้าน" :
          "เรื่องนี้ต้องให้พนักงานช่วยค่ะ กรุณาติดต่อร้านโดยตรง ขณะนี้ยังไม่ได้ส่งข้อความถึงพนักงาน";
      } else if (session.handoff && message.trim() !== "เริ่มใหม่") {
        text = "กรุณาติดต่อพนักงานของร้าน หรือเริ่มบทสนทนาใหม่ค่ะ";
      } else if (plan.intent === "search") {
        session.services = await call("list_services", {});
        const selected = session.services.find((s) => plan.value.includes(s.name) || plan.value.includes(stripParentheses(s.name)));
        if (!selected) { session.stage = "service"; choices = session.services.map((s) => ({ label: s.name, value: s.name })); text = "ต้องการบริการไหนคะ"; }
        else {
          Object.assign(session, { service: selected, staff: null, action: "create", booking: null, customer: null });
          session.staffList = await call("list_staff", { service_id: selected.id });
          session.date = plan.value.match(/\d{4}-\d{2}-\d{2}/)?.[0] ?? new Date(Date.now() + (7 + (plan.value.includes("พรุ่งนี้") ? 24 : 0)) * 3600000).toISOString().slice(0, 10);
          await slots();
          if (plan.value.includes("บ่าย")) {
            session.slots = session.slots.filter((s) => Number(new Intl.DateTimeFormat("en-GB", { hour: "2-digit", timeZone: "Asia/Bangkok" }).format(new Date(s.start_at))) >= 12);
            const allowed = new Set(session.slots.map((s) => `${s.staff_id} ${s.start_at}`));
            choices = choices.filter((c) => allowed.has(c.value));
            if (!choices.length) { text = "ช่วงบ่ายวันนี้ไม่มีเวลาว่าง กรุณาเลือกวันอื่นค่ะ"; session.stage = "date"; }
          }
        }
      } else if (plan.intent === "services" || (session.stage === "start" && plan.intent === "unknown")) {
        Object.assign(session, { pending: null, booking: null, customer: null, service: null, staff: null, slot: null, action: "create", handoff: false });
        session.services = await call("list_services", {}); session.stage = "service";
        text = session.services.length ? "เลือกบริการที่ต้องการค่ะ" : "ขณะนี้ยังไม่มีบริการเปิดจอง";
        choices = session.services.map((s) => ({ label: `${s.name} · ${s.price ?? "สอบถามร้าน"} บาท · ${s.duration_minutes} นาที`, value: s.name }));
      } else if ((plan.intent === "service" || plan.intent === "unknown") && session.stage === "service") {
        const resolved = matchOption(session.services, plan.value);
        const candidate = resolved.match ? resolved : matchOption(session.services, message.trim());
        if (candidate.match) {
          session.service = await call("get_service_details", { service_id: candidate.match.id });
          session.staffList = await call("list_staff", { service_id: candidate.match.id });
          session.stage = "staff";
          choices = [...session.staffList.map((s) => ({ label: s.name, value: s.name })), { label: "ใครก็ได้", value: "ใครก็ได้" }];
          text = "เลือกช่างที่ต้องการค่ะ";
        } else if (candidate.ambiguous.length > 1) {
          choices = candidate.ambiguous.map((s) => ({ label: `${s.name} · ${s.price ?? "สอบถามร้าน"} บาท · ${s.duration_minutes} นาที`, value: s.name }));
          text = "พบหลายบริการที่ตรงกับข้อความของคุณ กรุณาเลือกบริการที่ต้องการจากรายการด้านล่างค่ะ";
        } else {
          choices = session.services.map((s) => ({ label: `${s.name} · ${s.price ?? "สอบถามร้าน"} บาท · ${s.duration_minutes} นาที`, value: s.name }));
          text = "ไม่พบบริการที่ระบุค่ะ กรุณาเลือกจากหมายเลขหรือชื่อรายการที่แสดง";
        }
      } else if ((plan.intent === "staff" || plan.intent === "unknown") && session.stage === "staff") {
        const resolved = matchStaff(session.staffList, plan.value);
        const candidate = (resolved.match || resolved.isAny) ? resolved : matchStaff(session.staffList, message.trim());
        if (candidate.match) {
          session.staff = candidate.match;
          session.stage = "date";
          text = "ต้องการวันไหนคะ ระบุวันที่ ปี-เดือน-วัน หรือพิมพ์ พรุ่งนี้";
        } else if (candidate.isAny) {
          session.staff = null;
          session.stage = "date";
          text = "ต้องการวันไหนคะ ระบุวันที่ ปี-เดือน-วัน หรือพิมพ์ พรุ่งนี้";
        } else if (candidate.ambiguous.length > 1) {
          choices = [...candidate.ambiguous.map((s) => ({ label: s.name, value: s.name })), { label: "ใครก็ได้", value: "ใครก็ได้" }];
          text = "พบช่างหลายท่านที่ตรงกับข้อความของคุณ กรุณาระบุชื่อหรือหมายเลขช่างที่ต้องการค่ะ";
        } else {
          choices = [...session.staffList.map((s) => ({ label: s.name, value: s.name })), { label: "ใครก็ได้", value: "ใครก็ได้" }];
          text = "ไม่พบช่างที่ระบุค่ะ กรุณาเลือกจากหมายเลขหรือชื่อรายการที่แสดง หรือพิมพ์ ใครก็ได้";
        }
      } else if (plan.intent === "date" && session.stage === "date") {
        let date = plan.value;
        if (date === "พรุ่งนี้") date = new Date(Date.now() + (24 + 7) * 3600000).toISOString().slice(0, 10);
        session.date = date; await slots();
      } else if (plan.intent === "slot" && session.stage === "slot") {
        const selected = session.slots?.find((s) =>
          `${s.staff_id} ${s.start_at}` === plan.value ||
          s.start_at === plan.value ||
          formatTime(s.start_at) === plan.value ||
          (plan.value && `${formatTime(s.start_at)} · ${session.staffList?.find((st) => st.id === s.staff_id)?.name ?? "ช่าง"}` === plan.value)
        );
        if (!selected) {
          await slots();
          text = "กรุณาเลือกเวลาจากรายการที่ระบบตรวจสอบแล้วค่ะ";
        } else {
          session.slot = selected;
          session.staff = session.staffList?.find((s) => s.id === selected.staff_id) ?? session.staff;
          if (session.customer) review();
          else { session.stage = "contact"; text = "ขอชื่อและเบอร์โทรที่ใช้จองค่ะ เช่น มาลี 0812345678"; }
        }
      } else if (plan.intent === "contact" && session.stage === "contact") {
        const matched = plan.value?.match(/^(.{1,100}?)\s+([+\d][\d ()-]{8,23})$/);
        if (!matched || normalizePhone(matched[2]).length < 9) { text = "กรุณาระบุชื่อและเบอร์โทรให้ครบค่ะ"; }
        else { session.customer = { name: matched[1].trim(), phone: normalizePhone(matched[2]) }; review(); }
      } else if (plan.intent === "confirm" && message.trim() === "ยืนยัน" && session.pending) {
        const pending = session.pending;
        const tool = { create: "create_booking_request", reschedule: "request_reschedule", cancel: "request_cancel" }[pending.action];
        session.booking = await call(tool, { review_id: pending.id }, { confirmedReview: pending.id });
        session.stage = "success";
        text = pending.action === "cancel" ? "ยกเลิกนัดสำเร็จค่ะ" : pending.action === "reschedule" ? "เลื่อนนัดสำเร็จค่ะ" : "จองสำเร็จค่ะ";
      } else if (plan.intent === "manage") {
        session.booking = null; session.pending = null;
        const [id, phone] = (plan.value ?? "").split(/\s+/);
        const booking = await call("get_booking", { booking_id: id, phone });
        session.booking = booking; session.customer = { name: "ลูกค้าที่จอง", phone };
        session.service = await call("get_service_details", { service_id: booking.service_id });
        session.staffList = await call("list_staff", { service_id: booking.service_id });
        session.staff = session.staffList.find((s) => s.id === booking.staff_id) ?? null;
        session.slot = { staff_id: booking.staff_id, start_at: booking.start_at, end_at: booking.end_at };
        session.stage = "manage"; text = "พบข้อมูลนัดหมายที่ยืนยันแล้วค่ะ";
        choices = [{ label: "เลื่อนนัด", value: "เลื่อนนัด" }, { label: "ยกเลิกนัด", value: "ยกเลิกนัด" }];
      } else if (plan.intent === "reschedule" && session.booking && session.customer) {
        session.action = "reschedule"; session.pending = null; session.stage = "date"; text = "ต้องการเลื่อนไปวันที่เท่าไรคะ";
      } else if (plan.intent === "cancel" && session.booking && session.customer) {
        session.action = "cancel"; review();
      } else { text = "ยังไม่ได้ดำเนินการค่ะ กรุณาเลือกข้อมูลตามขั้นตอน หรือพิมพ์ เริ่มใหม่"; }
    } catch (error) {
      session.pending = null;
      logEvent("ai_receptionist_error", {
        code: error.code || "AI_RECEPTIONIST_ERROR",
        session_id: session?.id,
        error: error.message
      }, console.error);
      if (error.code === "CONFLICT" && session.service && session.date) {
        try { await slots(); } catch { session.slots = []; choices = []; }
        text = "ช่วงเวลานี้เพิ่งถูกจอง ยังจองไม่สำเร็จค่ะ กรุณาเลือกเวลาใหม่จากรายการล่าสุด";
      } else {
        text = ["FORBIDDEN", "RATE_LIMITED", "BAD_REQUEST"].includes(error.code) ? error.message : "ระบบไม่สามารถดำเนินการได้ ยังไม่ได้ยืนยันรายการ กรุณาลองใหม่หรือติดต่อพนักงาน";
        if (error.code === "FORBIDDEN") session.handoff = true;
      }
    }
    return { message: text, session_id: session.id, handoff: session.handoff, choices,
      state: { stage: session.stage, service: session.service, staff: session.staff, date: session.date,
        review: session.pending ? { id: session.pending.id, action: session.pending.action, service: session.service,
          staff: session.staff, slot: session.slot, customer_name: session.customer?.name,
          phone_last4: session.customer?.phone?.slice(-4), cancellation_window_hours: getBookingConfig().cancellationWindowHours } : null,
        booking: session.booking } };
  }
}
function formatTime(value) { return new Intl.DateTimeFormat("th-TH", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Bangkok" }).format(new Date(value)); }
function handoffReason(message) {
  if (/ร้องเรียน|complaint/i.test(message)) return "complaint";
  if (/ส่วนลด|ลดราคา|discount/i.test(message)) return "discount_request";
  if (/ยกเว้น|exception/i.test(message)) return "policy_exception";
  return "human_requested";
}

function normalizeText(text) {
  if (text == null) return "";
  return text
    .toString()
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .trim();
}

function stripParentheses(text) {
  return normalizeText(text)
    .replace(/\s*\([^)]*\)/g, "")
    .replace(/\s*（[^）]*）/g, "")
    .trim();
}

function stripLeadingIndex(text) {
  return normalizeText(text)
    .replace(/^(?:(?:ข้อ|เบอร์|เลือก(?:\s*ข้อ)?|ลำดับ(?:ที่)?)\s*)?\d{1,3}[\.\s\-:]+\s*(?=\S)/i, "")
    .trim();
}

function stripRenderedSuffix(text) {
  return normalizeText(text)
    .replace(/\s*[·•\-\|]\s*(?:[\d\.,]+|สอบถามร้าน)?\s*(?:บาท)?\s*[·•\-\|]\s*\d+\s*(?:นาที|ชม\.?|ชั่วโมง)?\s*$/i, "")
    .replace(/\s*[·•\-\|]\s*(?:[\d\.,]+|สอบถามร้าน)\s*บาท\s*$/i, "")
    .replace(/\s*[·•\-\|]\s*\d+\s*(?:นาที|ชม\.?|ชั่วโมง)\s*$/i, "")
    .trim();
}

function matchOption(list, input) {
  if (!Array.isArray(list) || list.length === 0 || input == null) {
    return { match: null, ambiguous: [] };
  }
  const raw = normalizeText(input);
  if (!raw) {
    return { match: null, ambiguous: [] };
  }

  // 1. Exact ID on raw
  const byId = list.find((item) => item.id && normalizeText(item.id) === raw);
  if (byId) return { match: byId, ambiguous: [] };

  // 2. Pure numeric index ("1", "2", "ข้อ 1", "เลือก 2", "1.", etc.)
  const numMatch = raw.match(/^(?:(?:ข้อ|เบอร์|เลือก(?:\s*ข้อ)?|ลำดับ(?:ที่)?)\s*)?(\d{1,3})\.?$/i);
  if (numMatch) {
    const idx = parseInt(numMatch[1], 10) - 1;
    if (idx >= 0 && idx < list.length) {
      return { match: list[idx], ambiguous: [] };
    }
  }

  // Pre-process text candidates
  const withoutIndex = stripLeadingIndex(raw);
  const cleaned = stripRenderedSuffix(withoutIndex);
  const cleanedFromRaw = stripRenderedSuffix(raw);
  const candidates = Array.from(new Set([raw, withoutIndex, cleaned, cleanedFromRaw].filter(Boolean)));
  const lowerCandidates = candidates.map((c) => c.toLowerCase());

  // 3. Exact ID on candidates (in case input was "1. <uuid>")
  const byIdCand = list.find((item) => item.id && candidates.includes(normalizeText(item.id)));
  if (byIdCand) return { match: byIdCand, ambiguous: [] };

  // 4. Exact name (case-insensitive) or full rendered label match
  const byName = list.find((item) => {
    if (!item.name) return false;
    const itemName = normalizeText(item.name).toLowerCase();
    const itemPrice = item.price != null ? item.price.toString() : "สอบถามร้าน";
    const itemLabel = normalizeText(`${item.name} · ${itemPrice} บาท · ${item.duration_minutes} นาที`).toLowerCase();
    return lowerCandidates.includes(itemName) || lowerCandidates.includes(itemLabel);
  });
  if (byName) return { match: byName, ambiguous: [] };

  // 5. Strip English parentheses and match main name
  const strippedCandidates = Array.from(new Set(candidates.map((c) => stripParentheses(c).toLowerCase()).filter(Boolean)));
  const strippedMatches = list.filter((item) => {
    if (!item.name) return false;
    const strippedItem = stripParentheses(item.name).toLowerCase();
    return strippedCandidates.includes(strippedItem);
  });
  if (strippedMatches.length === 1) {
    return { match: strippedMatches[0], ambiguous: [] };
  } else if (strippedMatches.length > 1) {
    return { match: null, ambiguous: strippedMatches };
  }

  // 6. Substring / contains with ambiguity handling
  const primaryClean = stripParentheses(cleaned).replace(/^(?:เลือก|ขอ(?:จอง)?|เอา)\s*/i, "").trim().toLowerCase();
  if (primaryClean.length >= 2) {
    const substringMatches = list.filter((item) => {
      if (!item.name) return false;
      const itemName = normalizeText(item.name).toLowerCase();
      const strippedItem = stripParentheses(item.name).toLowerCase();
      return strippedItem.includes(primaryClean) || itemName.includes(primaryClean);
    });
    if (substringMatches.length === 1) {
      return { match: substringMatches[0], ambiguous: [] };
    } else if (substringMatches.length > 1) {
      return { match: null, ambiguous: substringMatches };
    }
  }

  return { match: null, ambiguous: [] };
}

function matchStaff(staffList, input) {
  if (!Array.isArray(staffList) || staffList.length === 0 || input == null) {
    return { match: null, isAny: false, ambiguous: [] };
  }
  const norm = normalizeText(input);
  if (!norm) {
    return { match: null, isAny: false, ambiguous: [] };
  }
  // Check pure numeric index
  const numMatch = norm.match(/^(?:(?:ข้อ|เบอร์|เลือก(?:\s*ข้อ)?|ลำดับ(?:ที่)?)\s*)?(\d{1,3})\.?$/i);
  if (numMatch) {
    const idx = parseInt(numMatch[1], 10) - 1;
    if (idx === staffList.length) {
      return { match: null, isAny: true, ambiguous: [] };
    }
  }
  // Check "ใครก็ได้" / "any" (with or without leading index e.g. "4. ใครก็ได้")
  const withoutIndex = stripLeadingIndex(norm);
  if (
    /^(?:ใครก็ได้|ใครก้ได้|ใครก็ได้ครับ|ใครก็ได้ค่ะ|any|anyone)$/i.test(norm) ||
    /^(?:ใครก็ได้|ใครก้ได้|ใครก็ได้ครับ|ใครก็ได้ค่ะ|any|anyone)$/i.test(withoutIndex)
  ) {
    return { match: null, isAny: true, ambiguous: [] };
  }
  const res = matchOption(staffList, norm);
  return { match: res.match, isAny: false, ambiguous: res.ambiguous };
}

module.exports = { Receptionist, matchOption, matchStaff, stripParentheses, stripLeadingIndex, stripRenderedSuffix, normalizeText };
