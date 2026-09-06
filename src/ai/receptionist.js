const { randomUUID } = require("node:crypto");
const { MockAIProvider } = require("./provider");
const { getBookingConfig } = require("../config");
const { normalizePhone } = require("../security/access");

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
      const plan = sensitive ? { intent: "handoff" } : await this.provider.interpret({ message, state: {
        stage: session.stage, services: session.services.map((item) => item.name), staff: session.staffList.map((item) => item.name)
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
        const selected = session.services.find((s) => plan.value.includes(s.name));
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
      } else if (plan.intent === "service" && session.stage === "service") {
        const selected = session.services.find((s) => s.name === plan.value || s.id === plan.value);
        if (!selected) throw new Error("Unknown selection");
        session.service = await call("get_service_details", { service_id: selected.id });
        session.staffList = await call("list_staff", { service_id: selected.id }); session.stage = "staff";
        choices = [...session.staffList.map((s) => ({ label: s.name, value: s.name })), { label: "ใครก็ได้", value: "ใครก็ได้" }];
        text = "เลือกช่างที่ต้องการค่ะ";
      } else if (plan.intent === "staff" && session.stage === "staff") {
        const selected = session.staffList.find((s) => s.name === plan.value || s.id === plan.value);
        if (!selected && plan.value !== "ใครก็ได้") throw new Error("Unknown selection");
        session.staff = selected ?? null; session.stage = "date";
        text = "ต้องการวันไหนคะ ระบุวันที่ ปี-เดือน-วัน หรือพิมพ์ พรุ่งนี้";
      } else if (plan.intent === "date" && session.stage === "date") {
        let date = plan.value;
        if (date === "พรุ่งนี้") date = new Date(Date.now() + (24 + 7) * 3600000).toISOString().slice(0, 10);
        session.date = date; await slots();
      } else if (plan.intent === "slot" && session.stage === "slot") {
        const selected = session.slots.find((s) => `${s.staff_id} ${s.start_at}` === plan.value);
        if (!selected) { text = "กรุณาเลือกเวลาจากรายการที่ระบบตรวจสอบแล้วค่ะ"; await slots(); }
        else {
          session.slot = selected;
          session.staff = session.staffList.find((s) => s.id === selected.staff_id);
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
module.exports = { Receptionist };
