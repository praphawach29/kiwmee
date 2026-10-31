const { createHash } = require("node:crypto");
const { logEvent } = require("../observability/logger");
const { hasFeature, FEATURES, DEFAULT_SINGLE_BUSINESS_ID } = require("../licensing");
const {
  buildServiceCarousel,
  buildCategorySelectionBubble,
  buildStaffCarousel,
  buildDateSelectionBubble,
  buildSlotSelectionBubble,
  buildContactPromptBubble,
  buildReviewTicketBubble,
  buildBookingSuccessPassBubble,
  buildPaymentRequiredBubble,
  buildSlipReceivedBubble,
  buildPaymentVerifiedBubble,
  buildPaymentManualReviewBubble,
  buildPaymentFailedBubble,
  buildPaymentExpiredBubble
} = require("./line-flex-builder");
const { MockPaymentPresentationProvider } = require("../payment/presentation/payment-presentation");
const { MockMessageContentProvider } = require("./content-provider");
const { MockSlipProvider } = require("../payment/providers/mock-slip-provider");
const { SlipIntakeService } = require("../payment/slip-intake-service");

class LineWebhookService {
  constructor({
    messaging,
    sessions,
    receptionist,
    repository,
    limiter,
    channelSecret,
    businessId,
    entitlementService,
    hasFeatureFn,
    contentProvider,
    slipProvider,
    presentationProvider
  }) {
    Object.assign(this, { messaging, sessions, receptionist, repository, limiter, channelSecret });
    this.businessId = businessId || DEFAULT_SINGLE_BUSINESS_ID;
    this.entitlementService = entitlementService || null;
    this.hasFeatureFn = hasFeatureFn || null;
    this.contentProvider = contentProvider || new MockMessageContentProvider();
    this.slipProvider = slipProvider || new MockSlipProvider();
    this.presentationProvider = presentationProvider || new MockPaymentPresentationProvider();
  }

  async checkFeature(businessId, feature) {
    try {
      if (typeof this.hasFeatureFn === "function") {
        return await this.hasFeatureFn(businessId, feature);
      } else if (this.entitlementService) {
        return await this.entitlementService.hasFeature(businessId, feature);
      } else {
        return await hasFeature(businessId, feature);
      }
    } catch (err) {
      logEvent("line_webhook_entitlement_error", {
        feature,
        businessId,
        code: err?.code || "ENTITLEMENT_CHECK_FAILED"
      });
      return false;
    }
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
    const isImage = event.type === "message" && event.message?.type === "image";
    const isPostback = event.type === "postback" && typeof event.postback?.data === "string";
    if ((!isMessage && !isPostback && !isImage) || !event.source?.userId || !event.replyToken) return;

    const eventId = event.webhookEventId ?? createHash("sha256").update(JSON.stringify(event)).digest("hex");
    const claimed = await this.repository.claimLineEvent(eventId);
    if (!claimed) return;

    try {
      await this.limiter.consume("line-user", event.source.userId, { max: 60, windowMs: 60000 });
      const { session, owner } = await this.sessions.external(event.source.userId, this.channelSecret);
      const businessId = this.businessId || DEFAULT_SINGLE_BUSINESS_ID;

      // ==========================================
      // LINE Image Event Intake Flow (Phase E)
      // ==========================================
      if (isImage) {
        let reply = null;
        let resultCode = "SLIP_PROCESSED";
        let bookingId = null;

        await this.sessions.withSession(session.id, owner, async (state) => {
          const customerId = state.customer?.id || state.customerId || state.customer_id || state.owner || owner;
          let activePayment = state.payment;
          let paymentId = activePayment?.id || state.paymentId;

          // Rule B & C: When session.paymentId is absent, check customer's pending payments
          if (!paymentId && this.repository.findPendingPaymentsByCustomer && customerId) {
            const pendingList = await this.repository.findPendingPaymentsByCustomer(customerId);
            if (pendingList && pendingList.length === 1) {
              state.payment = pendingList[0];
              state.paymentId = pendingList[0].id;
              state.stage = "payment_pending";
              paymentId = pendingList[0].id;
            } else if (pendingList && pendingList.length > 1) {
              reply = {
                type: "text",
                text: "พบรายการรอชำระเงินมากกว่า 1 รายการ กรุณาระบุรหัสการจองที่ต้องการชำระเงินค่ะ"
              };
              resultCode = "MULTIPLE_PENDING_PAYMENTS";
              return;
            }
          }

          const isPending = paymentId && [
            "payment_pending",
            "slip_received",
            "verifying",
            "payment_failed",
            "payment_manual_review"
          ].includes(state.stage);

          // Check if LINE session has active payment pending
          if (!isPending) {
            reply = {
              type: "text",
              text: "ขณะนี้ไม่มีรายการที่รอชำระเงินค่ะ"
            };
            resultCode = "NO_PENDING_PAYMENT";
            return;
          }

          const slipAllowed = await this.checkFeature(businessId, FEATURES.slipVerification);
          const autoConfirmAllowed = await this.checkFeature(businessId, FEATURES.autoPaymentConfirmation);
          const flexAllowed = await this.checkFeature(businessId, FEATURES.lineFlex);

          const slipResult = await SlipIntakeService.processSlip({
            session: state,
            messageId: event.message.id,
            contentProvider: this.contentProvider,
            slipProvider: this.slipProvider,
            repository: this.repository,
            entitlements: {
              slipVerification: slipAllowed,
              autoPaymentConfirmation: autoConfirmAllowed
            },
            businessId,
            now: new Date()
          });

          resultCode = slipResult.code || "SLIP_PROCESSED";
          bookingId = slipResult.booking?.id || state.booking?.id || state.bookingId;

          reply = formatSlipReply(slipResult, state, {
            hasFlex: flexAllowed,
            businessId,
            presentationProvider: this.presentationProvider
          });
        });

        if (typeof this.messaging.replyMessages === "function") {
          await this.messaging.replyMessages(event.replyToken, [reply]);
        } else {
          await this.messaging.replyText(event.replyToken, reply);
        }

        await this.repository.completeLineEvent(eventId);

        logEvent("line_webhook_success", {
          stage: session.stage,
          action: "image",
          result_code: resultCode,
          booking_id: bookingId
        });
        return;
      }

      // ==========================================
      // Existing Text & Postback Flow
      // ==========================================
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

      const flexAllowed = await this.checkFeature(businessId, FEATURES.lineFlex);

      const reply = formatLineReply(result, {
        hasFlex: flexAllowed,
        businessId,
        presentationProvider: this.presentationProvider
      });

      if (typeof this.messaging.replyMessages === "function") {
        await this.messaging.replyMessages(event.replyToken, [reply]);
      } else {
        await this.messaging.replyText(event.replyToken, reply);
      }

      await this.repository.completeLineEvent(eventId);

      // Requirement 8: Logging
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

/**
 * Formats a reply for slip image processing results.
 */
function formatSlipReply(slipResult, state, options = {}) {
  const hasFlex = (options?.hasFlex === true || options?.lineFlex === true);

  if (slipResult.code === "PAYMENT_CONFIRMED" || slipResult.code === "IDEMPOTENT_ALREADY_CONFIRMED") {
    if (hasFlex) {
      const flexBubble = buildBookingSuccessPassBubble(slipResult.booking || state.booking, {
        service: state.service,
        staff: state.staff,
        slot: state.slot
      });
      return flexBubble;
    }
    const bId = slipResult.booking?.id || state.booking?.id;
    return {
      type: "text",
      text: `ชำระเงินสำเร็จและยืนยันการจองเรียบร้อยค่ะ 🎉\n\nรหัสนัดหมาย: ${bId}\nบริการ: ${state.service?.name || "บริการ"}\nช่าง: ${state.staff?.name || "ช่างประจำร้าน"}\nสถานะ: confirmed`,
      quickReply: {
        items: [
          {
            type: "action",
            action: {
              type: "postback",
              label: "จองบริการอื่น",
              data: "action=restart",
              displayText: "จองบริการอื่น"
            }
          }
        ]
      }
    };
  }

  if (slipResult.stage === "payment_manual_review") {
    const manualReviewNotice = "ได้รับข้อมูลการชำระเงินแล้วค่ะ\nกำลังรอร้านตรวจสอบและยืนยันการจอง";
    if (hasFlex) {
      return buildPaymentManualReviewBubble({
        booking: state.booking,
        payment: state.payment,
        reason: manualReviewNotice
      });
    }
    return {
      type: "text",
      text: manualReviewNotice,
      quickReply: {
        items: [
          {
            type: "action",
            action: {
              type: "postback",
              label: "จองบริการอื่น",
              data: "action=restart",
              displayText: "จองบริการอื่น"
            }
          }
        ]
      }
    };
  }

  if (
    slipResult.stage === "payment_failed" ||
    slipResult.code === "AMOUNT_MISMATCH" ||
    slipResult.code === "INVALID_SLIP" ||
    slipResult.code === "RECEIVER_MISMATCH" ||
    slipResult.code === "DUPLICATE_TRANSACTION" ||
    slipResult.code === "INVALID_IMAGE" ||
    slipResult.code === "EMPTY_BODY" ||
    slipResult.code === "OVERSIZED_IMAGE" ||
    slipResult.code === "INVALID_MIME_TYPE"
  ) {
    if (hasFlex) {
      return buildPaymentFailedBubble({
        booking: state.booking,
        payment: state.payment,
        reason: slipResult.message
      });
    }
    return {
      type: "text",
      text: `${slipResult.message}\n\nกรุณาส่งรูปสลิปใหม่อีกครั้ง หรือพิมพ์ 'ยกเลิก' เพื่อยกเลิกค่ะ`,
      quickReply: {
        items: [
          {
            type: "action",
            action: {
              type: "postback",
              label: "ยกเลิกการจอง",
              data: "action=cancel",
              displayText: "ยกเลิก"
            }
          }
        ]
      }
    };
  }

  return {
    type: "text",
    text: slipResult.message || "กำลังประมวลผลข้อมูลค่ะ"
  };
}

/**
 * Formats LINE reply from Receptionist output contract.
 * Automatically generates Flex Messages if entitled, with complete text fallbacks.
 */
function formatLineReply(result, options = {}) {
  const hasFlex = (options?.hasFlex === true || options?.lineFlex === true);
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
  } else if (result.state?.stage === "payment_pending" && result.state?.payment) {
    const p = result.state.payment;
    const serviceName = result.state.service?.name ?? "บริการ";
    const staffName = result.state.staff?.name ?? "ช่างประจำร้าน";
    const dateText = formatDateOnly(result.state.slot?.start_at);
    const timeText = formatTime(result.state.slot?.start_at);
    const servicePrice = Number(result.state.service?.price || 0);
    const amountNum = p.amountDueSatang !== undefined ? p.amountDueSatang / 100 : Number(p.amount_due || 0);
    const isDeposit = p.type === "deposit_fixed" || p.type === "deposit_percentage";
    const remaining = Math.max(0, servicePrice - amountNum);

    lines.push(
      "",
      `บริการ: ${serviceName}`,
      `ช่าง: ${staffName}`,
      `วันที่: ${dateText}`,
      `เวลา: ${timeText}`,
      `ราคาบริการเต็ม: ${servicePrice} บาท`,
      `ยอดที่ต้องชำระตอนนี้: ${amountNum} บาท (${isDeposit ? "มัดจำ" : "ชำระเต็ม"})`,
      ...(isDeposit ? [`ยอดคงเหลือจ่ายหน้าร้าน: ${remaining} บาท`] : []),
      `หมดเวลาชำระ: ${formatTime(p.expiresAt || p.expires_at)}`,
      "",
      "เมื่อชำระแล้ว ส่งรูปสลิปในแชทนี้ได้เลยค่ะ"
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

  if (result.state?.booking && (result.state?.stage === "success" || result.state?.stage === "booked")) {
    lines.push("", `รหัสนัด: ${result.state.booking.id}`, `สถานะ: ${result.state.booking.status}`);
  }

  const text = lines.filter((line) => line !== undefined).join("\n");

  let quickReply = null;
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

    quickReply = { items: quickReplyItems };
  }

  // Generate rich Flex Message based on current stage if entitled
  let flexMessage = null;
  const stage = result.state?.stage;

  if (hasFlex) {
    if (stage === "payment_pending" && result.state?.payment) {
      const presentationProvider = options.presentationProvider || new MockPaymentPresentationProvider();
      const presentation = presentationProvider.createPaymentPresentationSync
        ? presentationProvider.createPaymentPresentationSync({
            paymentId: result.state.payment.id,
            amountDueSatang: result.state.payment.amountDueSatang,
            currency: result.state.payment.currency,
            expiresAt: result.state.payment.expiresAt,
            businessId: options.businessId
          })
        : { displayAmount: `฿${result.state.payment.amountDueSatang / 100}` };

      flexMessage = buildPaymentRequiredBubble({
        service: result.state.service,
        staff: result.state.staff,
        slot: result.state.slot,
        booking: result.state.booking,
        payment: result.state.payment,
        presentation
      });
    } else if (stage === "slip_received" || stage === "verifying") {
      flexMessage = buildSlipReceivedBubble({
        booking: result.state.booking,
        payment: result.state.payment
      });
    } else if (stage === "payment_manual_review") {
      flexMessage = buildPaymentManualReviewBubble({
        booking: result.state.booking,
        payment: result.state.payment,
        reason: result.message
      });
    } else if (stage === "payment_failed") {
      flexMessage = buildPaymentFailedBubble({
        booking: result.state.booking,
        payment: result.state.payment,
        reason: result.message
      });
    } else if (stage === "payment_expired") {
      flexMessage = buildPaymentExpiredBubble({
        booking: result.state.booking,
        payment: result.state.payment
      });
    } else if (result.state?.booking && (stage === "success" || stage === "booked")) {
      flexMessage = buildBookingSuccessPassBubble(result.state.booking, {
        service: result.state.service,
        staff: result.state.staff,
        slot: result.state.slot
      });
    } else if (result.state?.review) {
      flexMessage = buildReviewTicketBubble(result.state.review);
    } else if (stage === "service" && result.state?.services?.length > 0) {
      flexMessage = buildServiceCarousel(result.state.services, {
        selectedCategory: result.state.selectedCategory,
        total: result.totalChoices ?? result.state.services.length
      });
    } else if (stage === "staff" && result.state?.staffList?.length > 0) {
      flexMessage = buildStaffCarousel(result.state.staffList, result.state.service);
    } else if (stage === "date") {
      flexMessage = buildDateSelectionBubble({
        service: result.state.service,
        staff: result.state.staff,
        today: getBangkokDate(0),
        tomorrow: getBangkokDate(1),
        maxDate: getBangkokDate(30)
      });
    } else if (stage === "slot" && result.state?.slots?.length > 0) {
      flexMessage = buildSlotSelectionBubble({
        service: result.state.service,
        staff: result.state.staff,
        date: result.state.date,
        slots: result.state.slots
      });
    } else if (stage === "contact") {
      flexMessage = buildContactPromptBubble({
        service: result.state.service,
        staff: result.state.staff,
        date: result.state.date,
        slot: result.state.slot
      });
    }
  }

  if (flexMessage) {
    flexMessage.altText = text;
    if (quickReply) flexMessage.quickReply = quickReply;
    Object.defineProperty(flexMessage, "text", {
      get() { return this.altText; },
      enumerable: false,
      configurable: true
    });
    return flexMessage;
  }

  const message = {
    type: "text",
    text
  };
  if (quickReply) message.quickReply = quickReply;
  return message;
}

async function formatLineReplyWithEntitlement(result, { businessId = DEFAULT_SINGLE_BUSINESS_ID, entitlementService = null, hasFeatureFn = null, presentationProvider = null } = {}) {
  let hasFlex = false;
  try {
    if (typeof hasFeatureFn === "function") {
      hasFlex = await hasFeatureFn(businessId, FEATURES.lineFlex);
    } else if (entitlementService) {
      hasFlex = await entitlementService.hasFeature(businessId, FEATURES.lineFlex);
    } else {
      hasFlex = await hasFeature(businessId, FEATURES.lineFlex);
    }
  } catch {
    hasFlex = false;
  }
  return formatLineReply(result, { hasFlex, businessId, presentationProvider });
}

function getBangkokDate(offsetDays = 0) {
  const date = new Date(Date.now() + offsetDays * 86400000);
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Bangkok", year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

function formatDateOnly(value) {
  return value ? new Intl.DateTimeFormat("th-TH", { timeZone: "Asia/Bangkok", day: "numeric", month: "long", year: "numeric" }).format(new Date(value)) : "";
}

function formatTime(value) {
  return value ? new Intl.DateTimeFormat("th-TH", { timeZone: "Asia/Bangkok", hour: "2-digit", minute: "2-digit" }).format(new Date(value)) : "";
}

function truncate(text, max = 20) {
  if (text == null) return "";
  const str = String(text);
  return str.length <= max ? str : str.slice(0, max - 1) + "…";
}

module.exports = {
  LineWebhookService,
  formatLineReply,
  formatSlipReply,
  formatLineReplyWithEntitlement,
  getBangkokDate,
  formatDateOnly,
  formatTime,
  truncate
};
