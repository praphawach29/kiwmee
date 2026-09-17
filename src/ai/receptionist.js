const { randomUUID } = require("node:crypto");
const { MockAIProvider } = require("./provider");
const { getBookingConfig } = require("../config");
const { normalizePhone } = require("../security/access");
const { logEvent } = require("../observability/logger");
const { hasFeature, FEATURES, DEFAULT_SINGLE_BUSINESS_ID } = require("../licensing");

class Receptionist {
  constructor(gateway, provider = new MockAIProvider(), handoffService = null, options = {}) {
    this.gateway = gateway;
    this.provider = provider;
    this.handoffService = handoffService;
    this.businessId = options?.businessId || DEFAULT_SINGLE_BUSINESS_ID;
    this.entitlementService = options?.entitlementService || null;
    this.hasFeatureFn = options?.hasFeatureFn || null;
  }

  async respond(session, message) {
    let choices = []; let text = "กรุณาเลือกบริการ หรือพิมพ์ ดูนัด ตามด้วยรหัสนัดและเบอร์โทร";
    const call = async (name, input, context = {}) => {
      const result = await this.gateway.execute(name, input, { session, ...context });
      if (!result.ok) { const error = new Error(result.error.message); error.code = result.error.code; throw error; }
      return result.data;
    };

    const slots = async (customMessage = null) => {
      session.slot = null; session.pending = null;
      const rawSlots = await call("check_availability", { service_id: session.service.id, staff_id: session.staff?.id ?? null, date: session.date });
      session.slots = Array.isArray(rawSlots) ? rawSlots : [];
      session.stage = "slot";
      session.totalChoices = session.slots.length;
      const allSlots = buildSlotChoices(session.slots, session.staffList);
      choices = paginateChoices(allSlots, 0);
      if (customMessage) {
        text = customMessage;
      } else {
        text = choices.length ? "เลือกเวลาที่ต้องการค่ะ" : "วันที่เลือกไม่มีเวลาว่าง กรุณาเลือกวันอื่นค่ะ";
      }
      if (!choices.length) {
        session.stage = "date";
        choices = buildDateChoices();
      }
    };

    const review = () => {
      session.pending = { id: randomUUID(), action: session.action || "create", expires: Date.now() + 10 * 60 * 1000,
        draft: structuredClone({ service: session.service, staff: session.staff, slot: session.slot, customer: session.customer, booking: session.booking }) };
      session.stage = "review";
      choices = buildReviewChoices(session.pending.id);
      text = "กรุณาตรวจสอบรายละเอียด แล้วกดยืนยันเพื่อดำเนินการค่ะ";
    };

    try {
      const trimmed = (message || "").trim();
      const postback = parsePostback(trimmed);

      if (postback) {
        if (postback.action === "restart" || postback.action === "start") {
          Object.assign(session, { pending: null, booking: null, customer: null, service: null, staff: null, slot: null, payment: null, paymentId: null, bookingId: null, action: "create", handoff: false });
          session.services = await call("list_services", {});
          session.stage = "service";
          session.totalChoices = session.services.length;
          text = session.services.length ? "เลือกบริการที่ต้องการค่ะ" : "ขณะนี้ยังไม่มีบริการเปิดจอง";
          choices = paginateChoices(buildServiceChoices(session.services), 0);
        } else if (postback.action === "cancel") {
          session.pending = null;
          session.booking = null;
          session.payment = null;
          session.paymentId = null;
          session.bookingId = null;
          session.stage = "service";
          if (!session.services) session.services = await call("list_services", {});
          choices = paginateChoices(buildServiceChoices(session.services), 0);
          text = "ยกเลิกรายการเรียบร้อยค่ะ หากต้องการจองใหม่ กรุณาเลือกบริการด้านล่างค่ะ";
        } else if (postback.action === "more") {
          const allChoices = getAllChoicesForStage(session);
          const offset = postback.offset || 0;
          choices = paginateChoices(allChoices, offset);
          text = `เลือกตัวเลือกที่ต้องการค่ะ (แสดง ${offset + 1}-${Math.min(offset + 12, allChoices.length)} จากทั้งหมด ${allChoices.length}):`;
        } else if (postback.action === "category") {
          if (!session.services) session.services = await call("list_services", {});
          session.stage = "service";
          const cat = postback.cat;
          session.selectedCategory = cat;
          let filtered = session.services;
          if (cat && cat !== "บริการทั้งหมด" && cat !== "all") {
            filtered = session.services.filter((s) => {
              const text = `${s.name} ${s.description || ""}`.toLowerCase();
              if (cat.includes("ตัด") || cat.includes("จัดทรง")) return /ตัดผม|haircut|สระไดร์|wash|blow|ทรง/i.test(text);
              if (cat.includes("สี") || cat.includes("เคมี")) return /สี|color|gloss|ไฮไลต์|ฟอก/i.test(text);
              if (cat.includes("สปา") || cat.includes("ทรีตเมนต์")) return /สปา|spa|ดีท็อกซ์|detox|ฟื้นฟู|treatment|บำรุง/i.test(text);
              return true;
            });
          }
          session.filteredServices = filtered;
          session.totalChoices = filtered.length;
          choices = paginateChoices(buildServiceChoices(filtered), 0);
          text = `เลือกบริการในหมวด "${cat}" ค่ะ:`;
        } else if (postback.action === "service") {
          if (session.stage && session.stage !== "service" && session.stage !== "start") {
            // Stale service postback
            text = getStagePrompt(session.stage);
            choices = paginateChoices(getAllChoicesForStage(session), 0);
          } else {
            if (!session.services) session.services = await call("list_services", {});
            const found = session.services?.find((s) => s.id === postback.service_id);
            if (found) {
              session.service = await call("get_service_details", { service_id: found.id });
              session.staffList = await call("list_staff", { service_id: found.id });
              session.stage = "staff";
              choices = paginateChoices(buildStaffChoices(session.staffList), 0);
              text = "เลือกช่างที่ต้องการค่ะ";
            } else {
              choices = paginateChoices(buildServiceChoices(session.services), 0);
              text = "ไม่พบบริการที่ระบุค่ะ กรุณาเลือกจากรายการที่แสดง";
            }
          }
        } else if (postback.action === "staff") {
          if (session.stage !== "staff") {
            // Stale staff postback
            text = getStagePrompt(session.stage);
            choices = paginateChoices(getAllChoicesForStage(session), 0);
          } else {
            if (postback.staff_id === "ANY_STAFF") {
              session.staff = null;
              session.stage = "date";
              choices = buildDateChoices();
              text = `ต้องการวันไหนคะ เลือกจากปุ่มด้านล่าง หรือระบุวันที่ (เช่น ${getBangkokDate(0)} หรือ ${getBangkokDate(0).split("-").reverse().join("/")})`;
            } else {
              if (!session.staffList && session.service) session.staffList = await call("list_staff", { service_id: session.service.id });
              const found = session.staffList?.find((s) => s.id === postback.staff_id);
              if (found) {
                session.staff = found;
                session.stage = "date";
                choices = buildDateChoices();
                text = `ต้องการวันไหนคะ เลือกจากปุ่มด้านล่าง หรือระบุวันที่ (เช่น ${getBangkokDate(0)} หรือ ${getBangkokDate(0).split("-").reverse().join("/")})`;
              } else {
                choices = paginateChoices(buildStaffChoices(session.staffList), 0);
                text = "ไม่พบช่างที่ระบุค่ะ กรุณาเลือกจากรายการที่แสดง หรือเลือก ใครก็ได้";
              }
            }
          }
        } else if (postback.action === "date" || postback.action === "date_picker") {
          if (session.stage !== "date") {
            // Stale date postback
            text = getStagePrompt(session.stage);
            choices = paginateChoices(getAllChoicesForStage(session), 0);
          } else {
            let targetDate;
            if (postback.date === "today" || postback.date === "วันนี้") targetDate = getBangkokDate(0);
            else if (postback.date === "tomorrow" || postback.date === "พรุ่งนี้") targetDate = getBangkokDate(1);
            else targetDate = parseDateInput(postback.date);

            if (!targetDate) {
              text = `รูปแบบวันที่ไม่ถูกต้องค่ะ กรุณาเลือกจากปุ่มด้านล่าง หรือพิมพ์ เช่น ${getBangkokDate(0)} หรือ ${getBangkokDate(0).split("-").reverse().join("/")}`;
              choices = buildDateChoices();
            } else {
              session.date = targetDate;
              await slots();
            }
          }
        } else if (postback.action === "slot") {
          if (session.stage !== "slot") {
            // Stale slot postback
            text = getStagePrompt(session.stage);
            choices = paginateChoices(getAllChoicesForStage(session), 0);
          } else {
            // Slot Freshness check
            const freshSlots = await call("check_availability", {
              service_id: session.service.id,
              staff_id: session.staff?.id ?? null,
              date: session.date
            });
            session.slots = freshSlots;
            const decodedStart = decodeURIComponent(postback.start_at || "");
            const matchedSlot = freshSlots.find((s) => s.staff_id === postback.staff_id && (s.start_at === decodedStart || s.start_at === postback.start_at));
            if (!matchedSlot) {
              await slots("เวลานี้เพิ่งถูกจองไปค่ะ กรุณาเลือกเวลาใหม่");
            } else {
              session.slot = matchedSlot;
              session.staff = session.staffList?.find((s) => s.id === matchedSlot.staff_id) ?? session.staff;
              if (session.customer) {
                review();
              } else {
                session.stage = "contact";
                text = "ขอชื่อและเบอร์โทรที่ใช้จองค่ะ เช่น มาลี 0812345678";
                choices = [];
              }
            }
          }
        } else if (postback.action === "confirm") {
          if (session.stage === "success" && session.booking) {
            text = `นัดหมายนี้ได้รับการยืนยันเรียบร้อยแล้วค่ะ รหัสนัด: ${session.booking.id}`;
            choices = [{ label: "จองบริการอื่น", fullLabel: "จองบริการอื่น", value: "เริ่มใหม่", postbackData: "action=restart" }];
          } else if (session.stage !== "review" || !session.pending) {
            text = "ไม่พบรายการที่รอการยืนยันค่ะ กรุณาเลือกบริการใหม่ หรือพิมพ์ เริ่มใหม่";
            choices = paginateChoices(getAllChoicesForStage(session), 0);
          } else if (postback.review_id && postback.review_id !== session.pending.id) {
            text = "รายการยืนยันนี้หมดอายุหรือถูกแก้ไขไปแล้ว กรุณาตรวจสอบข้อมูลล่าสุดค่ะ";
            review();
          } else {
            const pending = session.pending;
            const tool = { create: "create_booking_request", reschedule: "request_reschedule", cancel: "request_cancel" }[pending.action];
            const bookingResult = await call(tool, { review_id: pending.id }, { confirmedReview: pending.id });
            if (bookingResult?.status === "pending" && bookingResult?.payment) {
              session.booking = { id: bookingResult.id, status: bookingResult.status };
              session.payment = bookingResult.payment;
              session.paymentId = bookingResult.payment.id;
              session.bookingId = bookingResult.id;
              session.stage = "payment_pending";
              session.pending = null;
              const isDeposit = session.payment.type === "deposit_fixed" || session.payment.type === "deposit_percentage";
              const amountBaht = (Number(session.payment.amountDueSatang || 0) / 100).toLocaleString("th-TH");
              text = `กรุณาชำระเงิน${isDeposit ? "มัดจำ" : ""} ฿${amountBaht} เพื่อยืนยันการจองค่ะ\nเมื่อชำระแล้ว ส่งรูปสลิปในแชทนี้ได้เลยค่ะ`;
              choices = [{ label: "ยกเลิกการจอง", fullLabel: "ยกเลิกการจอง", value: "ยกเลิก", postbackData: "action=cancel" }];
            } else {
              session.booking = bookingResult;
              session.stage = "success";
              session.pending = null;
              session.payment = null;
              session.paymentId = null;
              text = pending.action === "cancel" ? "ยกเลิกนัดสำเร็จค่ะ" : pending.action === "reschedule" ? "เลื่อนนัดสำเร็จค่ะ" : "จองสำเร็จค่ะ";
              choices = [{ label: "จองบริการอื่น", fullLabel: "จองบริการอื่น", value: "เริ่มใหม่", postbackData: "action=restart" }];
            }
          }
        }
        return {
          message: text,
          session_id: session.id,
          handoff: session.handoff,
          choices,
          totalChoices: session.totalChoices ?? (choices ? choices.length : 0),
          state: {
            stage: session.stage,
            service: session.service,
            services: session.filteredServices || session.services || null,
            selectedCategory: session.selectedCategory || null,
            staff: session.staff,
            staffList: session.staffList || null,
            date: session.date,
            slot: session.slot,
            slots: session.slots || null,
            review: session.pending ? {
              id: session.pending.id,
              action: session.pending.action,
              service: session.service,
              staff: session.staff,
              slot: session.slot,
              customer_name: session.customer?.name,
              phone_last4: session.customer?.phone?.slice(-4),
              cancellation_window_hours: getBookingConfig().cancellationWindowHours
            } : null,
            booking: session.booking,
            payment: session.payment || null,
            paymentId: session.paymentId || session.payment?.id || null
          }
        };
      }

      // Natural language / text input fallback handling
      const sensitive = /ร้องเรียน|ส่วนลด|ลดราคา|ยกเว้น|คุยกับคน|คุยกับพนักงาน|complaint|discount|exception|human/i.test(trimmed);

      if (sensitive) {
        session.handoff = true; session.pending = null;
        if (this.handoffService) await this.handoffService.create(session, handoffReason(trimmed));
        text = this.handoffService ? "รับเรื่องไว้แล้วค่ะ พนักงานจะรับช่วงต่อผ่านช่องทางติดต่อของร้าน" :
          "เรื่องนี้ต้องให้พนักงานช่วยค่ะ กรุณาติดต่อร้านโดยตรง ขณะนี้ยังไม่ได้ส่งข้อความถึงพนักงาน";
      } else if (session.handoff && trimmed !== "เริ่มใหม่") {
        text = "กรุณาติดต่อพนักงานของร้าน หรือเริ่มบทสนทนาใหม่ค่ะ";
      } else if (trimmed === "เริ่มใหม่" || trimmed === "เปลี่ยนข้อมูล" || trimmed.toLowerCase() === "restart") {
        Object.assign(session, { pending: null, booking: null, customer: null, service: null, staff: null, slot: null, payment: null, paymentId: null, bookingId: null, action: "create", handoff: false });
        session.services = await call("list_services", {}); session.stage = "service";
        text = session.services.length ? "เลือกบริการที่ต้องการค่ะ" : "ขณะนี้ยังไม่มีบริการเปิดจอง";
        choices = paginateChoices(buildServiceChoices(session.services), 0);
      } else if (trimmed === "ยกเลิก" || trimmed.toLowerCase() === "cancel") {
        session.pending = null;
        session.booking = null;
        session.payment = null;
        session.paymentId = null;
        session.bookingId = null;
        session.stage = "service";
        if (!session.services) session.services = await call("list_services", {});
        choices = paginateChoices(buildServiceChoices(session.services), 0);
        text = "ยกเลิกรายการเรียบร้อยค่ะ หากต้องการจองใหม่ กรุณาเลือกบริการด้านล่างค่ะ";
      } else if (session.stage === "success" && (trimmed === "ยืนยัน" || trimmed === "ยืนยันการจอง" || trimmed.toLowerCase() === "confirm")) {
        // Confirmation idempotency: already confirmed
        text = `นัดหมายนี้ได้รับการยืนยันเรียบร้อยแล้วค่ะ รหัสนัด: ${session.booking?.id}`;
        choices = [{ label: "จองบริการอื่น", fullLabel: "จองบริการอื่น", value: "เริ่มใหม่", postbackData: "action=restart" }];
      } else if (session.stage === "review" && (trimmed === "ยืนยัน" || trimmed === "ยืนยันการจอง" || trimmed.toLowerCase() === "confirm") && session.pending) {
        const pending = session.pending;
        const tool = { create: "create_booking_request", reschedule: "request_reschedule", cancel: "request_cancel" }[pending.action];
        const bookingResult = await call(tool, { review_id: pending.id }, { confirmedReview: pending.id });
        if (bookingResult?.status === "pending" && bookingResult?.payment) {
          session.booking = { id: bookingResult.id, status: bookingResult.status };
          session.payment = bookingResult.payment;
          session.paymentId = bookingResult.payment.id;
          session.bookingId = bookingResult.id;
          session.stage = "payment_pending";
          session.pending = null;
          const isDeposit = session.payment.type === "deposit_fixed" || session.payment.type === "deposit_percentage";
          const amountBaht = (Number(session.payment.amountDueSatang || 0) / 100).toLocaleString("th-TH");
          text = `กรุณาชำระเงิน${isDeposit ? "มัดจำ" : ""} ฿${amountBaht} เพื่อยืนยันการจองค่ะ\nเมื่อชำระแล้ว ส่งรูปสลิปในแชทนี้ได้เลยค่ะ`;
          choices = [{ label: "ยกเลิกการจอง", fullLabel: "ยกเลิกการจอง", value: "ยกเลิก", postbackData: "action=cancel" }];
        } else {
          session.booking = bookingResult;
          session.stage = "success";
          session.pending = null;
          session.payment = null;
          session.paymentId = null;
          text = pending.action === "cancel" ? "ยกเลิกนัดสำเร็จค่ะ" : pending.action === "reschedule" ? "เลื่อนนัดสำเร็จค่ะ" : "จองสำเร็จค่ะ";
          choices = [{ label: "จองบริการอื่น", fullLabel: "จองบริการอื่น", value: "เริ่มใหม่", postbackData: "action=restart" }];
        }
      } else if (session.stage === "payment_pending") {
        const isDeposit = session.payment?.type === "deposit_fixed" || session.payment?.type === "deposit_percentage";
        const amountBaht = session.payment?.amountDueSatang ? (Number(session.payment.amountDueSatang) / 100).toLocaleString("th-TH") : "";
        text = `รายการจองของคุณกำลังรอชำระเงิน${isDeposit ? "มัดจำ" : ""} ฿${amountBaht} ค่ะ\nเมื่อชำระแล้ว กรุณาส่งรูปสลิปในแชทนี้ได้เลยค่ะ หรือพิมพ์ 'ยกเลิก' เพื่อยกเลิกรายการ`;
        choices = [{ label: "ยกเลิกการจอง", fullLabel: "ยกเลิกการจอง", value: "ยกเลิก", postbackData: "action=cancel" }];
      } else if (session.stage === "slip_received" || session.stage === "verifying") {
        text = "ระบบได้รับรูปสลิปแล้ว กำลังอยู่ระหว่างการตรวจสอบยอดเงิน กรุณารอสักครู่ค่ะ";
        choices = [{ label: "ยกเลิกการจอง", fullLabel: "ยกเลิกการจอง", value: "ยกเลิก", postbackData: "action=cancel" }];
      } else if (session.stage === "payment_manual_review") {
        text = "รายการจองของคุณอยู่ระหว่างการตรวจสอบโดยเจ้าหน้าที่ค่ะ ทางร้านจะแจ้งผลให้ทราบโดยเร็วที่สุดค่ะ";
        choices = [{ label: "จองบริการอื่น", fullLabel: "จองบริการอื่น", value: "เริ่มใหม่", postbackData: "action=restart" }];
      } else if (session.stage === "payment_failed") {
        text = "ตรวจสอบสลิปไม่สำเร็จค่ะ กรุณาส่งรูปสลิปใหม่อีกครั้ง หรือพิมพ์ 'ยกเลิก' เพื่อเริ่มจองใหม่ค่ะ";
        choices = [{ label: "ยกเลิกการจอง", fullLabel: "ยกเลิกการจอง", value: "ยกเลิก", postbackData: "action=cancel" }];
      } else if (session.stage === "payment_expired") {
        Object.assign(session, { pending: null, booking: null, customer: null, service: null, staff: null, slot: null, payment: null, paymentId: null, action: "create" });
        session.services = await call("list_services", {});
        session.stage = "service";
        text = "รายการชำระเงินหมดเวลาแล้วค่ะ กรุณาเลือกบริการใหม่ด้านล่างค่ะ:";
        choices = paginateChoices(buildServiceChoices(session.services), 0);
      } else if (session.stage === "contact") {
        const matched = trimmed.match(/^(.{1,100}?)\s+([+\d][\d ()-]{8,23})$/);
        if (!matched || normalizePhone(matched[2]).length < 9) {
          text = "กรุณาระบุชื่อและเบอร์โทรให้ครบค่ะ เช่น มาลี 0812345678";
          session.stage = "contact";
          choices = [];
        } else {
          session.customer = { name: matched[1].trim(), phone: normalizePhone(matched[2]) };
          review();
        }
      } else if (session.stage === "date") {
        const parsedDate = parseDateInput(trimmed);
        if (parsedDate) {
          session.date = parsedDate;
          await slots();
        } else {
          text = `รูปแบบวันที่ไม่ถูกต้องค่ะ กรุณาเลือกจากปุ่มด้านล่าง หรือพิมพ์ เช่น ${getBangkokDate(0)} หรือ ${getBangkokDate(0).split("-").reverse().join("/")}`;
          choices = buildDateChoices();
        }
      } else {
        // Check direct matches first before provider
        let directSlot = null;
        if (session.stage === "slot") {
          const numMatch = trimmed.match(/^(\d{1,3})\.?$/);
          if (numMatch && session.slots) {
            const idx = parseInt(numMatch[1], 10) - 1;
            if (idx >= 0 && idx < session.slots.length) directSlot = session.slots[idx];
          }
          if (!directSlot && session.slots) {
            directSlot = session.slots.find((s) =>
              `${s.staff_id} ${s.start_at}` === trimmed ||
              s.start_at === trimmed ||
              formatTime(s.start_at) === trimmed ||
              `${formatTime(s.start_at)} · ${session.staffList?.find((st) => st.id === s.staff_id)?.name ?? "ช่าง"}` === trimmed
            );
          }
        }

        if ((!session.services || !session.services.length) && (session.stage === "start" || session.stage === "service" || !session.stage)) {
          session.services = await call("list_services", {});
        }

        const hasDate = /พรุ่งนี้|วันนี้|\d{4}-\d{2}-\d{2}/.test(trimmed);
        const directService = !hasDate && session.stage === "service" && Array.isArray(session.services) && session.services.length
          ? matchOption(session.services, trimmed)
          : null;
        const directStaff = !hasDate && session.stage === "staff" && Array.isArray(session.staffList) && session.staffList.length
          ? matchStaff(session.staffList, trimmed)
          : null;

        let plan = directSlot ? { intent: "slot", value: `${directSlot.staff_id} ${directSlot.start_at}` }
          : (directService && directService.match) ? { intent: "service", value: directService.match.name }
          : (directStaff && directStaff.match) ? { intent: "staff", value: directStaff.match.name }
          : (directStaff && directStaff.isAny) ? { intent: "staff", value: "ใครก็ได้" }
          : null;

        if (!plan) {
          const businessId = session.businessId || this.businessId || DEFAULT_SINGLE_BUSINESS_ID;
          let aiAllowed = false;
          try {
            if (typeof this.hasFeatureFn === "function") {
              aiAllowed = await this.hasFeatureFn(businessId, FEATURES.aiReceptionist);
            } else if (this.entitlementService) {
              aiAllowed = await this.entitlementService.hasFeature(businessId, FEATURES.aiReceptionist);
            } else {
              aiAllowed = await hasFeature(businessId, FEATURES.aiReceptionist);
            }
          } catch (err) {
            logEvent("ai_receptionist_entitlement_error", {
              feature: FEATURES.aiReceptionist,
              businessId,
              code: err?.code || "ENTITLEMENT_CHECK_FAILED"
            });
            aiAllowed = false;
          }

          if (aiAllowed) {
            plan = await this.provider.interpret({
              message: trimmed,
              state: {
                stage: session.stage,
                services: session.services?.map((item) => item.name) ?? [],
                staff: session.staffList?.map((item) => item.name) ?? []
              }
            });
          } else {
            // AI is NOT entitled (e.g. BASIC or PRO plan)
            // Prevent LLM inference at server layer completely
            const currentStage = session.stage || "service";
            if (currentStage === "start" || currentStage === "service" || !session.stage) {
              if (!session.services || !session.services.length) session.services = await call("list_services", {});
              session.stage = "service";
              session.totalChoices = session.services.length;
              choices = paginateChoices(buildServiceChoices(session.services), 0);
              text = "ขออภัยค่ะ ขณะนี้ระบบเปิดให้บริการเลือกจองผ่านเมนูด้านล่าง หากต้องการสอบถามข้อมูลเพิ่มเติมสามารถติดต่อร้านได้โดยตรงค่ะ";
            } else {
              choices = paginateChoices(getAllChoicesForStage(session), 0);
              text = `${getStagePrompt(currentStage)} (หรือหากต้องการสอบถามข้อมูลอื่น สามารถติดต่อร้านได้โดยตรงค่ะ)`;
            }

            return {
              message: text,
              session_id: session.id,
              handoff: session.handoff,
              choices,
              totalChoices: session.totalChoices ?? (choices ? choices.length : 0),
              state: {
                stage: session.stage,
                service: session.service,
                services: session.filteredServices || session.services || null,
                selectedCategory: session.selectedCategory || null,
                staff: session.staff,
                staffList: session.staffList || null,
                date: session.date,
                slot: session.slot,
                slots: session.slots || null,
                review: session.pending ? {
                  id: session.pending.id,
                  action: session.pending.action,
                  service: session.service,
                  staff: session.staff,
                  slot: session.slot,
                  customer_name: session.customer?.name,
                  phone_last4: session.customer?.phone?.slice(-4),
                  cancellation_window_hours: getBookingConfig().cancellationWindowHours
                } : null,
                booking: session.booking
              }
            };
          }
        }

        if (!plan || typeof plan.intent !== "string" || Object.keys(plan).some((key) => !["intent", "value"].includes(key))) throw new Error("Invalid provider response");

        if (plan.intent === "search") {
          session.services = await call("list_services", {});
          const selected = session.services.find((s) => plan.value.includes(s.name) || plan.value.includes(stripParentheses(s.name)));
          if (!selected) {
            session.stage = "service";
            choices = paginateChoices(buildServiceChoices(session.services), 0);
            text = "ต้องการบริการไหนคะ";
          } else {
            Object.assign(session, { service: selected, staff: null, action: "create", booking: null, customer: null });
            session.staffList = await call("list_staff", { service_id: selected.id });
            session.date = plan.value.match(/\d{4}-\d{2}-\d{2}/)?.[0] ?? getBangkokDate(plan.value.includes("พรุ่งนี้") ? 1 : 0);
            await slots();
            if (plan.value.includes("บ่าย")) {
              session.slots = session.slots.filter((s) => Number(new Intl.DateTimeFormat("en-GB", { hour: "2-digit", timeZone: "Asia/Bangkok" }).format(new Date(s.start_at))) >= 12);
              const allowed = new Set(session.slots.map((s) => `${s.staff_id} ${s.start_at}`));
              choices = choices.filter((c) => allowed.has(c.value));
              if (!choices.length) { text = "ช่วงบ่ายวันนี้ไม่มีเวลาว่าง กรุณาเลือกวันอื่นค่ะ"; session.stage = "date"; choices = buildDateChoices(); }
            }
          }
        } else if (plan.intent === "services" || (session.stage === "start" && plan.intent === "unknown")) {
          Object.assign(session, { pending: null, booking: null, customer: null, service: null, staff: null, slot: null, action: "create", handoff: false });
          session.services = await call("list_services", {}); session.stage = "service";
          session.totalChoices = session.services.length;
          text = session.services.length ? "เลือกบริการที่ต้องการค่ะ" : "ขณะนี้ยังไม่มีบริการเปิดจอง";
          choices = paginateChoices(buildServiceChoices(session.services), 0);
        } else if ((plan.intent === "service" || plan.intent === "unknown") && session.stage === "service") {
          const resolved = matchOption(session.services, plan.value);
          const candidate = resolved.match ? resolved : matchOption(session.services, trimmed);
          if (candidate.match) {
            session.service = await call("get_service_details", { service_id: candidate.match.id });
            session.staffList = await call("list_staff", { service_id: candidate.match.id });
            session.stage = "staff";
            choices = paginateChoices(buildStaffChoices(session.staffList), 0);
            text = "เลือกช่างที่ต้องการค่ะ";
          } else if (candidate.ambiguous.length > 1) {
            choices = paginateChoices(candidate.ambiguous.map((s) => ({ id: s.id, label: `${s.name} · ${s.price ?? "สอบถามร้าน"} บาท · ${s.duration_minutes} นาที`, fullLabel: `${s.name} · ${s.price ?? "สอบถามร้าน"} บาท · ${s.duration_minutes} นาที`, value: s.name, postbackData: `action=service&service_id=${s.id}` })), 0);
            text = "พบหลายบริการที่ตรงกับข้อความของคุณ กรุณาเลือกบริการที่ต้องการจากรายการด้านล่างค่ะ";
          } else {
            choices = paginateChoices(buildServiceChoices(session.services), 0);
            text = "ไม่พบบริการที่ระบุค่ะ กรุณาเลือกจากหมายเลขหรือชื่อรายการที่แสดง";
          }
        } else if ((plan.intent === "staff" || plan.intent === "unknown") && session.stage === "staff") {
          const resolved = matchStaff(session.staffList, plan.value);
          const candidate = (resolved.match || resolved.isAny) ? resolved : matchStaff(session.staffList, trimmed);
          if (candidate.match) {
            session.staff = candidate.match;
            session.stage = "date";
            choices = buildDateChoices();
            text = "ต้องการวันไหนคะ ระบุวันที่ ปี-เดือน-วัน หรือพิมพ์ พรุ่งนี้";
          } else if (candidate.isAny) {
            session.staff = null;
            session.stage = "date";
            choices = buildDateChoices();
            text = "ต้องการวันไหนคะ ระบุวันที่ ปี-เดือน-วัน หรือพิมพ์ พรุ่งนี้";
          } else if (candidate.ambiguous.length > 1) {
            choices = paginateChoices([...candidate.ambiguous.map((s) => ({ id: s.id, label: s.name, value: s.name, postbackData: `action=staff&staff_id=${s.id}` })), { id: "ANY_STAFF", label: "ใครก็ได้", value: "ใครก็ได้", postbackData: "action=staff&staff_id=ANY_STAFF" }], 0);
            text = "พบช่างหลายท่านที่ตรงกับข้อความของคุณ กรุณาระบุชื่อหรือหมายเลขช่างที่ต้องการค่ะ";
          } else {
            choices = paginateChoices(buildStaffChoices(session.staffList), 0);
            text = "ไม่พบช่างที่ระบุค่ะ กรุณาเลือกจากหมายเลขหรือชื่อรายการที่แสดง หรือพิมพ์ ใครก็ได้";
          }
        } else if (plan.intent === "date" && session.stage === "date") {
          let date = plan.value;
          if (date === "พรุ่งนี้") date = getBangkokDate(1);
          else if (date === "วันนี้") date = getBangkokDate(0);
          else date = parseDateInput(date) ?? date;
          session.date = date; await slots();
        } else if (plan.intent === "slot" && session.stage === "slot") {
          const selected = session.slots?.find((s) =>
            `${s.staff_id} ${s.start_at}` === plan.value ||
            s.start_at === plan.value ||
            formatTime(s.start_at) === plan.value ||
            (plan.value && `${formatTime(s.start_at)} · ${session.staffList?.find((st) => st.id === s.staff_id)?.name ?? "ช่าง"}` === plan.value)
          );
          if (!selected) {
            await slots("กรุณาเลือกเวลาจากรายการที่ระบบตรวจสอบแล้วค่ะ");
          } else {
            // Freshness check with availability engine
            const freshSlots = await call("check_availability", {
              service_id: session.service.id,
              staff_id: session.staff?.id ?? null,
              date: session.date
            });
            session.slots = freshSlots;
            const freshMatched = freshSlots.find((s) => s.staff_id === selected.staff_id && s.start_at === selected.start_at);
            if (!freshMatched) {
              await slots("เวลานี้เพิ่งถูกจองไปค่ะ กรุณาเลือกเวลาใหม่");
            } else {
              session.slot = freshMatched;
              session.staff = session.staffList?.find((s) => s.id === freshMatched.staff_id) ?? session.staff;
              if (session.customer) review();
              else { session.stage = "contact"; text = "ขอชื่อและเบอร์โทรที่ใช้จองค่ะ เช่น มาลี 0812345678"; choices = []; }
            }
          }
        } else if (plan.intent === "contact" && session.stage === "contact") {
          const matched = plan.value?.match(/^(.{1,100}?)\s+([+\d][\d ()-]{8,23})$/);
          if (!matched || normalizePhone(matched[2]).length < 9) { text = "กรุณาระบุชื่อและเบอร์โทรให้ครบค่ะ"; }
          else { session.customer = { name: matched[1].trim(), phone: normalizePhone(matched[2]) }; review(); }
        } else if (plan.intent === "confirm" && (trimmed === "ยืนยัน" || trimmed === "ยืนยันการจอง" || trimmed.toLowerCase() === "confirm") && session.pending) {
          const pending = session.pending;
          const tool = { create: "create_booking_request", reschedule: "request_reschedule", cancel: "request_cancel" }[pending.action];
          const bookingResult = await call(tool, { review_id: pending.id }, { confirmedReview: pending.id });
          if (bookingResult?.status === "pending" && bookingResult?.payment) {
            session.booking = { id: bookingResult.id, status: bookingResult.status };
            session.payment = bookingResult.payment;
            session.paymentId = bookingResult.payment.id;
            session.bookingId = bookingResult.id;
            session.stage = "payment_pending";
            session.pending = null;
            const isDeposit = session.payment.type === "deposit_fixed" || session.payment.type === "deposit_percentage";
            const amountBaht = (Number(session.payment.amountDueSatang || 0) / 100).toLocaleString("th-TH");
            text = `กรุณาชำระเงิน${isDeposit ? "มัดจำ" : ""} ฿${amountBaht} เพื่อยืนยันการจองค่ะ\nเมื่อชำระแล้ว ส่งรูปสลิปในแชทนี้ได้เลยค่ะ`;
            choices = [{ label: "ยกเลิกการจอง", fullLabel: "ยกเลิกการจอง", value: "ยกเลิก", postbackData: "action=cancel" }];
          } else {
            session.booking = bookingResult;
            session.stage = "success";
            session.pending = null;
            session.payment = null;
            session.paymentId = null;
            text = pending.action === "cancel" ? "ยกเลิกนัดสำเร็จค่ะ" : pending.action === "reschedule" ? "เลื่อนนัดสำเร็จค่ะ" : "จองสำเร็จค่ะ";
            choices = [{ label: "จองบริการอื่น", fullLabel: "จองบริการอื่น", value: "เริ่มใหม่", postbackData: "action=restart" }];
          }
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
          choices = [{ label: "เลื่อนนัด", fullLabel: "เลื่อนนัด", value: "เลื่อนนัด" }, { label: "ยกเลิกนัด", fullLabel: "ยกเลิกนัด", value: "ยกเลิกนัด" }];
        } else if (plan.intent === "reschedule" && session.booking && session.customer) {
          session.action = "reschedule"; session.pending = null; session.stage = "date"; text = "ต้องการเลื่อนไปวันที่เท่าไรคะ"; choices = buildDateChoices();
        } else if (plan.intent === "cancel" && session.booking && session.customer) {
          session.action = "cancel"; review();
        } else {
          text = "ยังไม่ได้ดำเนินการค่ะ กรุณาเลือกข้อมูลตามขั้นตอน หรือพิมพ์ เริ่มใหม่";
          choices = paginateChoices(getAllChoicesForStage(session), 0);
        }
      }
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

    return {
      message: text,
      session_id: session.id,
      handoff: session.handoff,
      choices,
      totalChoices: session.totalChoices ?? (choices ? choices.length : 0),
      state: {
        stage: session.stage,
        service: session.service,
        services: session.filteredServices || session.services || null,
        selectedCategory: session.selectedCategory || null,
        staff: session.staff,
        staffList: session.staffList || null,
        date: session.date,
        slot: session.slot,
        slots: session.slots || null,
        review: session.pending ? {
          id: session.pending.id,
          action: session.pending.action,
          service: session.service,
          staff: session.staff,
          slot: session.slot,
          customer_name: session.customer?.name,
          phone_last4: session.customer?.phone?.slice(-4),
          cancellation_window_hours: getBookingConfig().cancellationWindowHours
        } : null,
        booking: session.booking
      }
    };
  }
}

function parsePostback(data) {
  if (typeof data !== "string" || !data.includes("action=")) return null;
  try {
    const params = new URLSearchParams(data);
    const action = params.get("action");
    if (!action) return null;
    return {
      action,
      service_id: params.get("service_id"),
      staff_id: params.get("staff_id"),
      date: params.get("date"),
      start_at: params.get("start_at"),
      review_id: params.get("review_id"),
      offset: params.get("offset") ? parseInt(params.get("offset"), 10) : 0,
      cat: params.get("cat"),
      stage: params.get("stage")
    };
  } catch {
    return null;
  }
}

function getBangkokDate(offsetDays = 0) {
  const date = new Date(Date.now() + offsetDays * 86400000);
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Bangkok", year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

function parseDateInput(input) {
  if (!input) return null;
  const str = input.trim();
  if (/^(?:วันนี้|today)$/i.test(str)) return getBangkokDate(0);
  if (/^(?:พรุ่งนี้|tomorrow)$/i.test(str)) return getBangkokDate(1);

  // YYYY-MM-DD or YYYY/MM/DD
  const ymd = str.match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/);
  if (ymd) {
    const y = parseInt(ymd[1], 10);
    const m = parseInt(ymd[2], 10);
    const d = parseInt(ymd[3], 10);
    if (m >= 1 && m <= 12 && d >= 1 && d <= 31) {
      const dt = new Date(Date.UTC(y, m - 1, d));
      if (dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d) {
        return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
      }
    }
    return null;
  }

  // DD/MM/YYYY or DD-MM-YYYY
  const dmy = str.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  if (dmy) {
    const d = parseInt(dmy[1], 10);
    const m = parseInt(dmy[2], 10);
    const y = parseInt(dmy[3], 10);
    if (m >= 1 && m <= 12 && d >= 1 && d <= 31) {
      const dt = new Date(Date.UTC(y, m - 1, d));
      if (dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d) {
        return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
      }
    }
    return null;
  }

  return null;
}

function buildServiceChoices(services) {
  if (!Array.isArray(services)) return [];
  return services.map((s) => ({
    id: s.id,
    label: `${s.name} · ${s.price ?? "สอบถามร้าน"} บาท · ${s.duration_minutes} นาที`,
    fullLabel: `${s.name} · ${s.price ?? "สอบถามร้าน"} บาท · ${s.duration_minutes} นาที`,
    shortLabel: s.name.length > 20 ? s.name.slice(0, 19) + "…" : s.name,
    value: s.name,
    postbackData: `action=service&service_id=${s.id}`
  }));
}

function buildStaffChoices(staffList) {
  const choices = Array.isArray(staffList)
    ? staffList.map((s) => ({
        id: s.id,
        label: s.name,
        fullLabel: s.name,
        shortLabel: s.name.length > 20 ? s.name.slice(0, 19) + "…" : s.name,
        value: s.name,
        postbackData: `action=staff&staff_id=${s.id}`
      }))
    : [];
  choices.push({
    id: "ANY_STAFF",
    label: "ใครก็ได้",
    fullLabel: "ใครก็ได้",
    shortLabel: "ใครก็ได้",
    value: "ใครก็ได้",
    postbackData: "action=staff&staff_id=ANY_STAFF"
  });
  return choices;
}

function buildDateChoices() {
  return [
    { label: "วันนี้", fullLabel: "วันนี้", value: "วันนี้", postbackData: "action=date&date=today" },
    { label: "พรุ่งนี้", fullLabel: "พรุ่งนี้", value: "พรุ่งนี้", postbackData: "action=date&date=tomorrow" },
    { label: "เลือกวันที่อื่น", fullLabel: "เลือกวันที่อื่น", value: "เลือกวันที่อื่น", type: "datetimepicker", postbackData: "action=date_picker" }
  ];
}

function buildSlotChoices(slots, staffList) {
  if (!Array.isArray(slots)) return [];
  return slots.map((slot) => {
    const staffName = staffList?.find((s) => s.id === slot.staff_id)?.name ?? "ช่าง";
    const time = formatTime(slot.start_at);
    return {
      label: `${time} · ${staffName}`,
      fullLabel: `${time} · ${staffName}`,
      shortLabel: `${time} · ${staffName}`.length > 20 ? time : `${time} · ${staffName}`,
      value: `${slot.staff_id} ${slot.start_at}`,
      postbackData: `action=slot&staff_id=${slot.staff_id}&start_at=${encodeURIComponent(slot.start_at)}`
    };
  });
}

function buildReviewChoices(pendingId) {
  return [
    { label: "ยืนยันการจอง", fullLabel: "ยืนยันการจอง", value: "ยืนยัน", postbackData: `action=confirm&review_id=${pendingId}` },
    { label: "เปลี่ยนข้อมูล", fullLabel: "เปลี่ยนข้อมูล", value: "เริ่มใหม่", postbackData: "action=restart" },
    { label: "ยกเลิก", fullLabel: "ยกเลิก", value: "ยกเลิก", postbackData: "action=cancel" }
  ];
}

function getAllChoicesForStage(session) {
  if (session.stage === "service") return buildServiceChoices(session.services);
  if (session.stage === "staff") return buildStaffChoices(session.staffList);
  if (session.stage === "date") return buildDateChoices();
  if (session.stage === "slot") return buildSlotChoices(session.slots, session.staffList);
  if (session.stage === "review") return session.pending ? buildReviewChoices(session.pending.id) : [];
  if (session.stage === "success") return [{ label: "จองบริการอื่น", fullLabel: "จองบริการอื่น", value: "เริ่มใหม่", postbackData: "action=restart" }];
  return [];
}

function getStagePrompt(stage) {
  switch (stage) {
    case "service": return "เลือกบริการที่ต้องการค่ะ หรือพิมพ์ เริ่มใหม่ เพื่อดูรายการบริการ";
    case "staff": return "เลือกช่างที่ต้องการค่ะ หรือพิมพ์ เริ่มใหม่ เพื่อเลือกบริการใหม่";
    case "date": return `ต้องการวันไหนคะ เลือกจากปุ่มด้านล่าง หรือระบุวันที่ เช่น ${getBangkokDate(0)}`;
    case "slot": return "เลือกเวลาที่ต้องการค่ะ หรือพิมพ์ เริ่มใหม่ เพื่อเลือกบริการใหม่";
    case "contact": return "ขอชื่อและเบอร์โทรที่ใช้จองค่ะ เช่น มาลี 0812345678";
    case "review": return "กรุณาตรวจสอบรายละเอียดการจองด้านล่าง แล้วกดยืนยันเพื่อดำเนินการค่ะ";
    case "success": return "นัดหมายนี้ได้รับการยืนยันเรียบร้อยแล้วค่ะ";
    default: return "กรุณาเลือกบริการ หรือพิมพ์ ดูนัด ตามด้วยรหัสนัดและเบอร์โทร";
  }
}

function paginateChoices(allChoices, offset = 0) {
  if (!Array.isArray(allChoices) || allChoices.length <= 13) return allChoices ?? [];
  const limit = 12;
  const paged = allChoices.slice(offset, offset + limit);
  if (offset + limit < allChoices.length) {
    paged.push({
      label: `ดูเพิ่ม (${offset + limit + 1}-${allChoices.length})`,
      fullLabel: `ดูเพิ่ม (${offset + limit + 1}-${allChoices.length})`,
      value: "ดูเพิ่ม",
      postbackData: `action=more&offset=${offset + limit}`
    });
  }
  if (offset > 0) {
    paged.unshift({
      label: "ก่อนหน้า",
      fullLabel: "ก่อนหน้า",
      value: "ก่อนหน้า",
      postbackData: `action=more&offset=${Math.max(0, offset - limit)}`
    });
  }
  return paged;
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

module.exports = {
  Receptionist,
  matchOption,
  matchStaff,
  stripParentheses,
  stripLeadingIndex,
  stripRenderedSuffix,
  normalizeText,
  parsePostback,
  parseDateInput,
  getBangkokDate,
  buildServiceChoices,
  buildStaffChoices,
  buildDateChoices,
  buildSlotChoices,
  buildReviewChoices,
  getAllChoicesForStage,
  paginateChoices,
  getStagePrompt
};
