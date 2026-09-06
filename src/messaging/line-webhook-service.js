const { createHash } = require("node:crypto");
const { logEvent } = require("../observability/logger");
class LineWebhookService {
  constructor({ messaging, sessions, receptionist, repository, limiter, channelSecret }) {
    Object.assign(this, { messaging, sessions, receptionist, repository, limiter, channelSecret });
  }
  async handle(raw, signature) {
    if (!this.messaging.verifySignature(raw, signature)) { const error = new Error("Invalid LINE signature"); error.code = "INVALID_SIGNATURE"; throw error; }
    let body;
    try { body = JSON.parse(raw); } catch { const error = new Error("Invalid LINE payload"); error.code = "BAD_REQUEST"; throw error; }
    for (const event of body.events ?? []) await this.handleEvent(event);
    return { accepted: true };
  }
  async handleEvent(event) {
    if (event.type !== "message" || event.message?.type !== "text" || !event.source?.userId || !event.replyToken) return;
    const eventId = event.webhookEventId ?? createHash("sha256").update(JSON.stringify(event)).digest("hex");
    const claimed = await this.repository.claimLineEvent(eventId); if (!claimed) return;
    try {
      await this.limiter.consume("line-user", event.source.userId, { max: 60, windowMs: 60000 });
      const { session, owner } = await this.sessions.external(event.source.userId, this.channelSecret);
      const result = await this.sessions.withSession(session.id, owner,
        (state) => this.receptionist.respond(state, event.message.text.slice(0, 2000)));
      await this.messaging.replyText(event.replyToken, formatLineReply(result));
      await this.repository.completeLineEvent(eventId);
    } catch (error) {
      await this.repository.failLineEvent(eventId);
      logEvent("line_webhook_failure", { code: error.code ?? "LINE_WEBHOOK_ERROR", channel: "line" });
      throw error;
    }
  }
}
function formatLineReply(result) {
  const lines = [result.message];
  if (result.choices?.length) lines.push("", ...result.choices.slice(0, 12).map((item, index) => `${index + 1}. ${item.label}`), "", "ตอบด้วยข้อความของตัวเลือกที่ต้องการ");
  if (result.state?.review) {
    const r = result.state.review;
    lines.push("", `บริการ: ${r.service?.name}`, `ช่าง: ${r.staff?.name}`, `เวลา: ${formatDate(r.slot?.start_at)}`,
      `ราคา: ${r.service?.price ?? "สอบถามร้าน"} บาท`, "ตอบ ยืนยัน เพื่อดำเนินการ");
  }
  if (result.state?.booking) lines.push("", `รหัสนัด: ${result.state.booking.id}`, `สถานะ: ${result.state.booking.status}`);
  return lines.filter((line) => line !== undefined).join("\n");
}
function formatDate(value) { return value ? new Intl.DateTimeFormat("th-TH", { timeZone: "Asia/Bangkok", dateStyle: "medium", timeStyle: "short" }).format(new Date(value)) : ""; }
module.exports = { LineWebhookService, formatLineReply };
