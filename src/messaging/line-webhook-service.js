const { createHash } = require("node:crypto");
const { logEvent } = require("../observability/logger");

class LineWebhookService {
  constructor({ messaging, sessions, receptionist, repository, limiter, channelSecret }) {
    Object.assign(this, { messaging, sessions, receptionist, repository, limiter, channelSecret });
  }

  async handle(raw, signature) {
    if (!this.messaging.verifySignature(raw, signature)) {
      const error = new Error("Invalid LINE signature");
      error.code = "INVALID_SIGNATURE";
      throw error;
    }
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      const error = new Error("Invalid LINE payload");
      error.code = "BAD_REQUEST";
      throw error;
    }
    for (const event of body.events ?? []) {
      await this.handleEvent(event);
    }
    return { accepted: true };
  }

  async handleEvent(event) {
    const isMessage = event.type === "message" && event.message?.type === "text";
    const isPostback = event.type === "postback" && typeof event.postback?.data === "string";
    if ((!isMessage && !isPostback) || !event.source?.userId || !event.replyToken) return;

    const eventId = event.webhookEventId ?? createHash("sha256").update(JSON.stringify(event)).digest("hex");
    const claimed = await this.repository.claimLineEvent(eventId);
    if (!claimed) return;

    try {
      await this.limiter.consume("line-user", event.source.userId, { max: 60, windowMs: 60000 });
      const { session, owner } = await this.sessions.external(event.source.userId, this.channelSecret);

      let textInput;
      if (isPostback) {
        let data = event.postback.data;
        if (event.postback.params?.date) {
          const params = new URLSearchParams(data);
          params.set("date", event.postback.params.date);
          data = params.toString();
        }
        textInput = data;
      } else {
        textInput = event.message.text.slice(0, 2000);
      }

      const result = await this.sessions.withSession(session.id, owner,
        (state) => this.receptionist.respond(state, textInput));

      const reply = formatLineReply(result);
      if (typeof this.messaging.replyMessages === "function") {
        await this.messaging.replyMessages(event.replyToken, [reply]);
      } else {
        await this.messaging.replyText(event.replyToken, reply);
      }

      await this.repository.completeLineEvent(eventId);

      // Requirement 8: Logging
      // log only: stage, action, result code, booking reference when created
      // DO NOT log full message, phone, token, secret
      const actionName = isPostback ? (new URLSearchParams(textInput).get("action") ?? "postback") : "text";
      logEvent("line_webhook_success", {
        stage: result.state?.stage,
        action: actionName,
        result_code: result.state?.booking ? "BOOKED" : "OK",
        booking_id: result.state?.booking?.id
      });
    } catch (error) {
      await this.repository.failLineEvent(eventId);
      logEvent("line_webhook_failure", { code: error.code ?? "LINE_WEBHOOK_ERROR", channel: "line" });
      throw error;
    }
  }
}

function formatLineReply(result) {
  const lines = [result.message];

  if (result.state?.review) {
    const r = result.state.review;
    lines.push(
      "",
      `บริการ: ${r.service?.name}`,
      `ช่าง: ${r.staff?.name ?? "ใครก็ได้"}`,
      `วันที่: ${formatDateOnly(r.slot?.start_at)}`,
      `เวลา: ${formatTime(r.slot?.start_at)}`,
      `ระยะเวลา: ${r.service?.duration_minutes ?? 60} นาที`,
      `ราคา: ${r.service?.price ?? "สอบถามร้าน"} บาท`,
      "",
      "กรุณาตรวจสอบและกดยืนยันการจองด้านล่างค่ะ"
    );
  } else if (result.choices?.length && result.state?.stage !== "date") {
    lines.push("");
    const maxTextChoices = Math.min(result.choices.length, 12);
    for (let i = 0; i < maxTextChoices; i++) {
      const item = result.choices[i];
      lines.push(`${i + 1}. ${item.fullLabel ?? item.label}`);
    }
    const total = result.totalChoices ?? result.choices.length;
    if (result.choices.length > 12 || total > 12) {
      lines.push(`(มีทั้งหมด ${total} รายการ กดปุ่ม "ดูเพิ่ม" หรือพิมพ์หมายเลขเพื่อเลือก)`);
    } else {
      lines.push("", "ตอบด้วยหมายเลขหรือข้อความของตัวเลือกที่ต้องการ");
    }
  }

  if (result.state?.booking) {
    lines.push("", `รหัสนัด: ${result.state.booking.id}`, `สถานะ: ${result.state.booking.status}`);
  }

  const text = lines.filter((line) => line !== undefined).join("\n");

  const message = {
    type: "text",
    text
  };

  if (Array.isArray(result.choices) && result.choices.length > 0) {
    const rawItems = result.choices.slice(0, 13);
    const quickReplyItems = rawItems.map((c) => {
      if (c.type === "datetimepicker") {
        const today = getBangkokDate(0);
        const maxDate = getBangkokDate(30);
        return {
          type: "action",
          action: {
            type: "datetimepicker",
            label: truncate(c.label, 20),
            data: c.postbackData || "action=date_picker",
            mode: "date",
            initial: today,
            min: today,
            max: maxDate
          }
        };
      }
      return {
        type: "action",
        action: {
          type: "postback",
          label: truncate(c.label, 20),
          data: c.postbackData || c.value,
          displayText: truncate(c.displayText || c.label, 300)
        }
      };
    });

    message.quickReply = { items: quickReplyItems };
  }

  return message;
}

function getBangkokDate(offsetDays = 0) {
  const date = new Date(Date.now() + offsetDays * 86400000);
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Bangkok", year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

function formatDateOnly(value) {
  return value ? new Intl.DateTimeFormat("th-TH", { timeZone: "Asia/Bangkok", dateStyle: "medium" }).format(new Date(value)) : "";
}

function formatTime(value) {
  return value ? new Intl.DateTimeFormat("th-TH", { timeZone: "Asia/Bangkok", hour: "2-digit", minute: "2-digit" }).format(new Date(value)) : "";
}

function truncate(text, max = 20) {
  if (text == null) return "";
  const str = String(text);
  return str.length <= max ? str : str.slice(0, max - 1) + "…";
}

module.exports = { LineWebhookService, formatLineReply, getBangkokDate, formatDateOnly, formatTime, truncate };
