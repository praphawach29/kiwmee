const { tools } = require("./catalog");
const { auditTool } = require("../audit");
const messages = {
  CONFLICT: "ช่วงเวลานี้เพิ่งถูกจอง กรุณาเลือกเวลาใหม่",
  FORBIDDEN: "ไม่สามารถดำเนินการได้ กรุณาตรวจข้อมูลยืนยันหรือติดต่อพนักงาน",
  BAD_REQUEST: "ข้อมูลไม่ถูกต้อง กรุณาตรวจสอบอีกครั้ง",
  RATE_LIMITED: "กรุณารอสักครู่แล้วลองใหม่",
  TOOL_ERROR: "ระบบขัดข้อง ยังไม่ได้ยืนยันการดำเนินการ กรุณาลองใหม่หรือติดต่อพนักงาน"
};
function failure(code) { return { ok: false, error: { code: messages[code] ? code : "TOOL_ERROR", message: messages[code] ?? messages.TOOL_ERROR } }; }
const projectBooking = (b) => ({ id: b.id, service_id: b.service_id, staff_id: b.staff_id, start_at: b.start_at, end_at: b.end_at, status: b.status });
class ToolGateway {
  constructor(api) { this.api = api; }
  async execute(name, input, context = {}) {
    const result = await this.run(name, input, context);
    auditTool(tools.some((tool) => tool.name === name) ? name : "forbidden", result);
    return result;
  }
  async run(name, input, context = {}) {
    const tool = tools.find((item) => item.name === name);
    if (!tool) return failure("FORBIDDEN");
    if (!tool.validateInput(input)) return failure("BAD_REQUEST");
    try {
      let data;
      const service = (s) => ({ id: s.id, name: s.name, price: s.price, duration_minutes: s.duration_minutes });
      if (name === "list_services") data = (await this.api.services()).map(service);
      else if (name === "get_service_details") {
        const found = (await this.api.services()).find((s) => s.id === input.service_id);
        if (!found) return failure("BAD_REQUEST");
        data = service(found);
      } else if (name === "list_staff") data = (await this.api.staff(input.service_id)).map(({ id, name }) => ({ id, name }));
      else if (name === "check_availability") {
        const date = new Date(`${input.date}T00:00:00Z`);
        if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== input.date) return failure("BAD_REQUEST");
        data = (await this.api.availability(input)).slots.map(({ staff_id, start_at, end_at }) => ({ staff_id, start_at, end_at }));
      } else if (name === "get_booking") data = projectBooking(await this.api.detail(input.booking_id, input.phone));
      else {
        const pending = context.session?.pending;
        const expected = { create_booking_request: "create", request_reschedule: "reschedule", request_cancel: "cancel" }[name];
        if (!pending || pending.id !== input.review_id || context.confirmedReview !== pending.id || pending.action !== expected || pending.expires < Date.now()) return failure("FORBIDDEN");
        // Consume before awaiting: a second call cannot reuse this confirmation.
        context.session.pending = null;
        const draft = pending.draft;
        if (name === "create_booking_request") data = projectBooking(await this.api.create({
          service_id: draft.service.id, staff_id: draft.slot.staff_id, start_at: draft.slot.start_at,
          customer: { name: draft.customer.name, phone: draft.customer.phone,
            contact_channel: context.session.channel?.type ?? "web",
            line_user_id: context.session.channel?.type === "line" ? context.session.channel.user_id : undefined }, source: "ai"
        }));
        else if (name === "request_reschedule") data = projectBooking(await this.api.reschedule(draft.booking.id, draft.customer.phone,
          { staff_id: draft.slot.staff_id, start_at: draft.slot.start_at, reason: "customer via receptionist" }));
        else data = projectBooking(await this.api.cancel(draft.booking.id, draft.customer.phone));
      }
      const result = { ok: true, data };
      return tool.validateOutput(result) ? result : failure("TOOL_ERROR");
    } catch (error) { return failure(error.code); }
  }
}
module.exports = { ToolGateway, failure };
