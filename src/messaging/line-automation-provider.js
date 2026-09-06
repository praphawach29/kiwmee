const { ConsoleNotificationProvider } = require("../automation/providers");
class LineAutomationNotificationProvider {
  constructor(repository, messaging, fallback = new ConsoleNotificationProvider()) {
    this.repository = repository; this.messaging = messaging; this.fallback = fallback;
  }
  sendConfirmation(payload) { return this.send(payload, `ยืนยันหรืออัปเดตนัดหมายแล้ว\nเวลา: ${format(payload.start_at)}\nรหัสนัด: ${payload.booking_id}`, "sendConfirmation"); }
  sendReminder(payload) { return this.send(payload, `แจ้งเตือนนัดหมาย\nเวลา: ${format(payload.start_at)}\nรหัสนัด: ${payload.booking_id}`, "sendReminder"); }
  sendCancellation(payload) { return this.send(payload, `ยกเลิกนัดหมายแล้ว\nรหัสนัด: ${payload.booking_id}`, "sendCancellation"); }
  sendFollowUp(payload) { return this.send(payload, `ข้อความติดตามนัดหมาย\nรหัสนัด: ${payload.booking_id}`, "sendFollowUp"); }
  async send(payload, text, fallbackMethod) {
    const booking = await this.repository.getBookingDetail(payload.booking_id);
    if (booking?.customer?.line_user_id) return this.messaging.pushText(booking.customer.line_user_id, text);
    return this.fallback[fallbackMethod](payload);
  }
}
function format(value) { return new Intl.DateTimeFormat("th-TH", { timeZone: "Asia/Bangkok", dateStyle: "medium", timeStyle: "short" }).format(new Date(value)); }
module.exports = { LineAutomationNotificationProvider };
