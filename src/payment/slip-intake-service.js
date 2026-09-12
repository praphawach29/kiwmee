// Salon Booking OS v1 - Payment Slip Intake Service
// Orchestrates image validation, deterministic association, mock slip verification,
// entitlement enforcement, idempotency, and atomic confirmation.

const { randomUUID } = require("node:crypto");
const { validateImageContent } = require("../messaging/content-provider");
const { PAYMENT_STATUSES } = require("./payment-state-machine");
const {
  DEFAULT_VERIFICATION_GRACE_MINUTES,
  DEFAULT_MANUAL_REVIEW_DEADLINE_MINUTES,
  evaluateSlipVerification
} = require("./payment-service");
const { confirmVerifiedPayment } = require("./payment-confirmation-service");
const { PAYMENT_REASON_CODES } = require("./reason-codes");
const { logEvent } = require("../observability/logger");

async function recordPaymentAttempt(repository, attempt) {
  if (repository.createPaymentAttempt) {
    return repository.createPaymentAttempt(attempt);
  }
  if (repository.insertPaymentAttempt) {
    return repository.insertPaymentAttempt(attempt);
  }
  return null;
}

async function updatePaymentAttemptRecord(repository, id, patch) {
  if (repository.updatePaymentAttempt) {
    return repository.updatePaymentAttempt(id, patch);
  }
  return null;
}

class SlipIntakeService {
  /**
   * Processes an incoming slip image message:
   * 1. Deterministic session/payment association (Rules A, B, C, D, E).
   * 2. Validates image size, MIME format, and computes SHA-256.
   * 3. Checks duplicate slip submission.
   * 4. Creates PaymentAttempt audit row BEFORE external verifier call.
   * 5. Marks payment slip_received and verifies entitlements.
   * 6. Updates attempt to verifying and calls SlipVerificationProvider outside DB transaction.
   * 7. Persists normalized provider result safely.
   * 8. Executes domain decision and calls confirmVerifiedPayment() atomically only if eligible.
   */
  static async processSlip({
    session,
    messageId,
    contentProvider,
    slipProvider,
    repository,
    entitlements = {},
    businessId = "default",
    now = new Date()
  }) {
    const nowDate = now instanceof Date ? now : new Date(now);
    let activePayment = session.payment;
    let paymentId = activePayment?.id || session.paymentId;
    const customerId = session.customer?.id || session.customerId || session.customer_id || session.owner;

    // =========================================================================
    // 1. Multiple Pending Payment Binding (Rules A, B, C, D, E)
    // =========================================================================

    // Rule B & C: session.paymentId is absent -> attempt lookup by customer
    if (!paymentId) {
      if (repository.findPendingPaymentsByCustomer && customerId) {
        const pendingList = await repository.findPendingPaymentsByCustomer(customerId);
        if (pendingList && pendingList.length === 1) {
          // Rule B: exactly 1 active pending payment found -> auto-bind
          activePayment = pendingList[0];
          paymentId = activePayment.id;
          session.payment = activePayment;
          session.paymentId = paymentId;
          session.stage = "payment_pending";
        } else if (pendingList && pendingList.length > 1) {
          // Rule C: >1 active pending payments -> MULTIPLE_PENDING_PAYMENTS
          return {
            success: false,
            code: "MULTIPLE_PENDING_PAYMENTS",
            message: "พบรายการรอชำระเงินมากกว่า 1 รายการ กรุณาระบุรหัสการจองที่ต้องการชำระเงินค่ะ",
            pendingPayments: pendingList
          };
        }
      }
    }

    // If still no paymentId
    if (!paymentId) {
      return {
        success: false,
        code: "NO_PENDING_PAYMENT",
        message: "ขณะนี้ไม่มีรายการที่รอชำระเงินค่ะ"
      };
    }

    // Retrieve payment from repository to verify existence, status, and ownership
    const paymentRecord = await (
      repository.getPaymentById?.(paymentId) ??
      repository.getPaymentForUpdate?.(paymentId)
    );

    if (!paymentRecord) {
      return {
        success: false,
        code: "NO_PENDING_PAYMENT",
        message: "ขณะนี้ไม่มีรายการที่รอชำระเงินค่ะ"
      };
    }

    // Retrieve associated booking
    const bookingRecord = await (
      repository.getBookingById?.(paymentRecord.original_booking_id) ??
      repository.getBooking?.(paymentRecord.original_booking_id)
    );

    // Rule D: session.paymentId points to payment that does not belong to current customer/session
    if (bookingRecord && customerId && bookingRecord.customer_id) {
      let isMatch = bookingRecord.customer_id === customerId;
      if (!isMatch && repository.findCustomerById) {
        const cust = await repository.findCustomerById(bookingRecord.customer_id);
        if (cust && cust.line_user_id === customerId) isMatch = true;
      }
      if (!isMatch && bookingRecord.line_user_id === customerId) {
        isMatch = true;
      }
      if (!isMatch) {
        return {
          success: false,
          code: "PAYMENT_SESSION_MISMATCH",
          message: "รายการชำระเงินนี้ไม่ตรงกับบัญชีผู้ใช้งานปัจจุบันค่ะ"
        };
      }
    }

    // Rule E: paid / expired / cancelled booking -> cannot accept slip as new pending payment
    if (bookingRecord && ["expired", "cancelled", "no_show"].includes(bookingRecord.status)) {
      return {
        success: false,
        code: "BOOKING_INELIGIBLE",
        message: `รายการจองนี้อยู่ในสถานะ ${bookingRecord.status} ไม่สามารถชำระเงินได้แล้วค่ะ`
      };
    }

    if (paymentRecord.status === PAYMENT_STATUSES.expired) {
      return {
        success: false,
        code: "PAYMENT_EXPIRED",
        message: "รายการชำระเงินนี้หมดอายุแล้วค่ะ กรุณาทำรายการจองใหม่ค่ะ"
      };
    }

    // =========================================================================
    // 2. Download and validate image binary
    // =========================================================================
    let imageContent;
    try {
      imageContent = await contentProvider.getImageContent(messageId);
    } catch (err) {
      logEvent("slip_download_failed", {
        messageId,
        paymentId,
        code: err.code || "DOWNLOAD_FAILED"
      });
      return {
        success: false,
        code: "DOWNLOAD_FAILED",
        message: "ไม่สามารถดาวน์โหลดรูปภาพได้ กรุณาส่งใหม่อีกครั้งค่ะ"
      };
    }

    const validation = validateImageContent(imageContent);
    if (!validation.valid) {
      return {
        success: false,
        code: validation.code || "INVALID_IMAGE",
        message: validation.message || "ไฟล์รูปภาพไม่ถูกต้องค่ะ กรุณาส่งรูปสลิปในรูปแบบ JPG หรือ PNG ขนาดไม่เกิน 5MB ค่ะ",
        stage: session.stage
      };
    }

    const slipHash = validation.hash;

    // =========================================================================
    // 3. Duplicate Slip Check (Pre-check secondary signal)
    // =========================================================================
    if (repository.findPaymentAttemptBySlipHash) {
      const existingAttempt = await repository.findPaymentAttemptBySlipHash(slipHash);
      if (existingAttempt) {
        if (existingAttempt.payment_id === paymentId) {
          // Same slip for same payment: Idempotent replay safe behavior
          if (paymentRecord.status === PAYMENT_STATUSES.paid) {
            return {
              success: true,
              code: "IDEMPOTENT_ALREADY_CONFIRMED",
              stage: "success",
              message: "สลิปนี้ได้รับการยืนยันการชำระเงินเรียบร้อยแล้วค่ะ",
              booking: session.booking || bookingRecord,
              payment: paymentRecord
            };
          }
        } else {
          // Re-used slip across different payments -> DUPLICATE_TRANSACTION (Reject/fraud path)
          await recordPaymentAttempt(repository, {
            id: randomUUID(),
            payment_id: paymentId,
            attempt_type: "slip_upload",
            slip_hash: slipHash,
            verification_provider: "mock_slip",
            provider_status: "rejected",
            normalized_result: "duplicate",
            failure_reason_code: "DUPLICATE_TRANSACTION",
            created_at: nowDate.toISOString()
          });

          session.stage = "payment_failed";
          return {
            success: false,
            code: "DUPLICATE_TRANSACTION",
            stage: "payment_failed",
            message: "สลิปนี้เคยถูกใช้งานไปแล้ว ไม่สามารถใช้ซ้ำได้ค่ะ"
          };
        }
      }
    }

    // Rule E: If payment is already paid and not an idempotent re-submission of the same slip
    if (paymentRecord.status === PAYMENT_STATUSES.paid) {
      return {
        success: false,
        code: "PAYMENT_ALREADY_PAID",
        message: "รายการจองนี้ได้รับการชำระเงินเรียบร้อยแล้วค่ะ ไม่สามารถรับสลิปใหม่ได้"
      };
    }

    // =========================================================================
    // 4. Payment Attempt Audit Order (Requirement 2)
    // Step A: Create PaymentAttempt with provider_status = 'received' BEFORE provider call
    // =========================================================================
    const attemptId = randomUUID();
    const providerIdentifier = slipProvider?.getCapabilities?.()?.providerName ||
      slipProvider?.providerName ||
      "mock_slip";

    await recordPaymentAttempt(repository, {
      id: attemptId,
      payment_id: paymentId,
      attempt_type: "slip_upload",
      slip_hash: slipHash,
      verification_provider: providerIdentifier,
      provider_status: "received",
      normalized_result: "provider_error",
      failure_reason_code: "PENDING_VERIFICATION",
      created_at: nowDate.toISOString()
    });

    // Step B: Mark payment slip_received
    const verificationDeadline = new Date(
      nowDate.getTime() + DEFAULT_VERIFICATION_GRACE_MINUTES * 60 * 1000
    ).toISOString();

    session.stage = "slip_received";
    if (repository.updatePayment) {
      await repository.updatePayment(paymentId, {
        status: PAYMENT_STATUSES.slipReceived,
        verification_deadline: verificationDeadline,
        updated_at: nowDate.toISOString()
      });
      await repository.insertPaymentEvent?.({
        id: randomUUID(),
        payment_id: paymentId,
        event_type: "slip_received",
        from_status: PAYMENT_STATUSES.pending,
        to_status: PAYMENT_STATUSES.slipReceived,
        actor: "customer",
        reason_code: "SLIP_UPLOADED",
        metadata: { slip_hash: slipHash, verification_deadline: verificationDeadline },
        created_at: nowDate.toISOString()
      });
    }

    // Step C: Strict Fail-Closed Entitlement Check: slipVerification === true
    const slipVerificationAllowed = entitlements?.slipVerification === true;
    const autoConfirmAllowed = entitlements?.autoPaymentConfirmation === true;

    if (!slipVerificationAllowed) {
      const manualReviewDeadline = new Date(
        nowDate.getTime() + DEFAULT_MANUAL_REVIEW_DEADLINE_MINUTES * 60 * 1000
      ).toISOString();

      await updatePaymentAttemptRecord(repository, attemptId, {
        verification_provider: "manual",
        provider_status: "manual_pending",
        normalized_result: "provider_error",
        failure_reason_code: "MANUAL_SLIP_VERIFICATION_REQUIRED"
      });

      if (repository.updatePayment) {
        await repository.updatePayment(paymentId, {
          status: PAYMENT_STATUSES.manualReview,
          manual_review_deadline: manualReviewDeadline,
          updated_at: nowDate.toISOString()
        });
        await repository.insertPaymentEvent?.({
          id: randomUUID(),
          payment_id: paymentId,
          event_type: "manual_review_requested",
          from_status: PAYMENT_STATUSES.slipReceived,
          to_status: PAYMENT_STATUSES.manualReview,
          actor: "system",
          reason_code: "AUTO_VERIFICATION_DISABLED",
          metadata: { slip_hash: slipHash, manual_review_deadline: manualReviewDeadline },
          created_at: nowDate.toISOString()
        });
      }

      session.stage = "payment_manual_review";
      return {
        success: true,
        code: "MANUAL_REVIEW_QUEUED",
        stage: "payment_manual_review",
        message: "ได้รับสลิปแล้วค่ะ เจ้าหน้าที่จะทำการตรวจสอบยอดเงินและยืนยันการจองให้อีกครั้งค่ะ"
      };
    }

    // Step D: Update attempt to 'verifying' and mark payment verifying
    session.stage = "verifying";
    await updatePaymentAttemptRecord(repository, attemptId, {
      provider_status: "verifying"
    });

    if (repository.updatePayment) {
      await repository.updatePayment(paymentId, {
        status: PAYMENT_STATUSES.verifying,
        updated_at: nowDate.toISOString()
      });
      await repository.insertPaymentEvent?.({
        id: randomUUID(),
        payment_id: paymentId,
        event_type: "verification_started",
        from_status: PAYMENT_STATUSES.slipReceived,
        to_status: PAYMENT_STATUSES.verifying,
        actor: "system",
        reason_code: "AUTO_VERIFICATION_STARTED",
        metadata: { slip_hash: slipHash },
        created_at: nowDate.toISOString()
      });
    }

    // Step E: Call SlipVerificationProvider OUTSIDE any database transaction
    const expectedAmount = activePayment?.amount_due !== undefined
      ? Number(activePayment.amount_due)
      : (paymentRecord?.amount_due !== undefined
        ? Number(paymentRecord.amount_due)
        : (Number(activePayment?.amountDueSatang || 0) / 100));

    let verificationResult;
    let verificationError = null;

    try {
      verificationResult = await slipProvider.verifySlip({
        slipData: imageContent.buffer,
        expectedAmount,
        expectedReceiver: businessId
      });
    } catch (err) {
      verificationError = err;
    }

    // Step F: Handle Provider Timeout or Failure (preserves attempt row)
    if (verificationError) {
      const isTimeout = verificationError.code === "PROVIDER_TIMEOUT" ||
        verificationError.message?.toLowerCase().includes("timed out");

      const manualReviewDeadline = new Date(
        nowDate.getTime() + DEFAULT_MANUAL_REVIEW_DEADLINE_MINUTES * 60 * 1000
      ).toISOString();

      await updatePaymentAttemptRecord(repository, attemptId, {
        provider_status: isTimeout ? "timeout" : "error",
        normalized_result: "provider_error",
        failure_reason_code: isTimeout ? "TIMEOUT" : (verificationError.code || "PROVIDER_ERROR")
      });

      if (repository.updatePayment) {
        await repository.updatePayment(paymentId, {
          status: PAYMENT_STATUSES.manualReview,
          manual_review_deadline: manualReviewDeadline,
          updated_at: nowDate.toISOString()
        });
        await repository.insertPaymentEvent?.({
          id: randomUUID(),
          payment_id: paymentId,
          event_type: "manual_review_requested",
          from_status: PAYMENT_STATUSES.verifying,
          to_status: PAYMENT_STATUSES.manualReview,
          actor: "system",
          reason_code: isTimeout ? "VERIFIER_TIMEOUT" : "VERIFIER_ERROR",
          metadata: { manual_review_deadline: manualReviewDeadline },
          created_at: nowDate.toISOString()
        });
      }

      session.stage = "payment_manual_review";
      if (isTimeout) {
        return {
          success: false,
          code: "TIMEOUT",
          stage: "payment_manual_review",
          message: "ระบบกำลังตรวจสอบสลิปของท่าน หากใช้เวลานานทางร้านจะตรวจสอบให้โดยตรงค่ะ"
        };
      }
      return {
        success: false,
        code: "PROVIDER_ERROR",
        stage: "payment_manual_review",
        message: "ระบบเกิดข้อผิดพลาดในการตรวจสอบสลิป ทางร้านจะตรวจสอบให้โดยตรงค่ะ"
      };
    }

    // Step G: Persist Normalized Result Safely
    const evalTarget = {
      id: paymentId,
      business_id: businessId,
      amount_due: expectedAmount
    };

    const evalResult = evaluateSlipVerification({
      payment: evalTarget,
      verificationResult,
      expectedReceiver: businessId
    });

    await updatePaymentAttemptRecord(repository, attemptId, {
      provider_request_id: verificationResult.provider_request_id ?? null,
      provider_status: verificationResult.provider_status ?? "completed",
      normalized_result: verificationResult.normalized_result ?? "provider_error",
      verified_amount: verificationResult.verified_amount ?? null,
      verified_receiver: verificationResult.verified_receiver ?? null,
      verified_sender: verificationResult.verified_sender ?? null,
      verified_transaction_reference: verificationResult.verified_transaction_reference ?? null,
      verified_transaction_at: verificationResult.verified_transaction_at ?? null,
      failure_reason_code: evalResult.reasonCode || verificationResult.failure_reason_code || null
    });

    // Step H: Authoritative Confirmation Gate (Requires all 12 invariants)
    if (evalResult.eligibleForAutoConfirmation && evalResult.recommendedStatus === PAYMENT_STATUSES.paid) {
      // Gate 1: Check booking is still pending
      const isBookingStillPending = bookingRecord && bookingRecord.status === "pending";

      // Gate 2: Check payment is still eligible (not expired)
      const isPaymentStillEligible = paymentRecord && paymentRecord.status !== PAYMENT_STATUSES.expired;

      // Gate 3: Check slot still belongs to booking (no other active booking took the slot)
      let slotTakenByOther = false;
      if (bookingRecord && repository.findConflictingActiveBooking) {
        const conflict = await repository.findConflictingActiveBooking(
          bookingRecord.staff_id,
          bookingRecord.start_at,
          bookingRecord.end_at,
          bookingRecord.id
        );
        if (conflict) {
          slotTakenByOther = true;
        }
      }

      if (!isBookingStillPending || !isPaymentStillEligible || slotTakenByOther) {
        // Late Payment Invariant: Persist evidence, do NOT confirm original booking, do NOT reclaim slot
        if (repository.updatePayment) {
          await repository.updatePayment(paymentId, {
            status: PAYMENT_STATUSES.manualReview,
            updated_at: nowDate.toISOString()
          });
          await repository.insertPaymentEvent?.({
            id: randomUUID(),
            payment_id: paymentId,
            event_type: "late_payment_detected",
            from_status: paymentRecord.status,
            to_status: PAYMENT_STATUSES.manualReview,
            actor: "system",
            reason_code: "LATE_PAYMENT_REVIEW",
            metadata: {
              slot_taken: slotTakenByOther,
              booking_status: bookingRecord?.status,
              transaction_reference: verificationResult.verified_transaction_reference || verificationResult.transactionReference
            },
            created_at: nowDate.toISOString()
          });
        }

        session.stage = "payment_manual_review";
        return {
          success: false,
          code: "LATE_PAYMENT_MANUAL_REVIEW",
          route: "LATE_PAYMENT_MANUAL_REVIEW",
          stage: "payment_manual_review",
          message: "ช่วงเวลาการจองนี้หมดอายุหรือถูกจัดสรรให้คิวอื่นแล้ว ระบบได้บันทึกหลักฐานการชำระเงินเพื่อส่งต่อให้เจ้าหน้าที่ดูแลการคืนเงินหรือจัดสรรคิวใหม่ค่ะ",
          booking: bookingRecord,
          payment: paymentRecord,
          evidence: {
            transactionReference: verificationResult.verified_transaction_reference || verificationResult.transactionReference,
            verifiedAmount: verificationResult.verified_amount
          }
        };
      }

      if (!autoConfirmAllowed) {
        if (repository.updatePayment) {
          await repository.updatePayment(paymentId, {
            status: PAYMENT_STATUSES.manualReview,
            updated_at: nowDate.toISOString()
          });
          await repository.insertPaymentEvent?.({
            id: randomUUID(),
            payment_id: paymentId,
            event_type: "manual_review_requested",
            from_status: PAYMENT_STATUSES.verifying,
            to_status: PAYMENT_STATUSES.manualReview,
            actor: "system",
            reason_code: "AUTO_CONFIRMATION_DISABLED",
            metadata: { slip_hash: slipHash },
            created_at: nowDate.toISOString()
          });
        }

        session.stage = "payment_manual_review";
        return {
          success: true,
          code: "MANUAL_REVIEW_ROUTED",
          stage: "payment_manual_review",
          message: "สลิปได้รับการตรวจสอบเบื้องต้นแล้ว ระบบส่งให้ทางร้านตรวจสอบขั้นสุดท้ายก่อนยืนยันค่ะ"
        };
      }

      // Auto-confirmation enabled: Execute atomic payment and booking confirmation
      let confirmResult;
      try {
        confirmResult = await confirmVerifiedPayment(repository, {
          paymentId,
          verifiedAmount: verificationResult.verified_amount,
          transactionNamespace: verificationResult.transactionNamespace || "promptpay_qr",
          transactionReference: verificationResult.verified_transaction_reference || verificationResult.transactionReference,
          actor: "slip_verifier",
          now: nowDate
        });
      } catch (confirmErr) {
        logEvent("payment_confirmation_failed", {
          paymentId,
          attemptId,
          error: confirmErr.message
        });
        throw confirmErr;
      }

      // Clear active payment session binding
      session.payment = null;
      session.paymentId = null;
      session.stage = "success";
      session.booking = confirmResult.booking;

      return {
        success: true,
        code: "PAYMENT_CONFIRMED",
        stage: "success",
        message: "ชำระเงินสำเร็จและยืนยันการจองเรียบร้อยค่ะ 🎉",
        booking: confirmResult.booking,
        payment: confirmResult.payment
      };
    }

    // Invalid / Mismatch / Non-Authoritative Scenarios:
    if (evalResult.reasonCode === "NON_AUTHORITATIVE_VERIFICATION") {
      if (repository.updatePayment) {
        await repository.updatePayment(paymentId, {
          status: PAYMENT_STATUSES.manualReview,
          updated_at: nowDate.toISOString()
        });
      }
      session.stage = "payment_manual_review";
      return {
        success: true,
        code: "NON_AUTHORITATIVE_MANUAL_REVIEW",
        stage: "payment_manual_review",
        message: "สลิปนี้ต้องรอเจ้าหน้าที่ตรวจสอบความถูกต้องก่อนยืนยันการจองค่ะ"
      };
    }

    if (evalResult.reasonCode === "INSUFFICIENT_RECEIVER_DATA") {
      if (repository.updatePayment) {
        await repository.updatePayment(paymentId, {
          status: PAYMENT_STATUSES.manualReview,
          updated_at: nowDate.toISOString()
        });
      }
      session.stage = "payment_manual_review";
      return {
        success: true,
        code: "INSUFFICIENT_RECEIVER_DATA",
        stage: "payment_manual_review",
        message: "ข้อมูลบัญชีผู้รับในสลิปไม่เพียงพอต่อการตรวจสอบอัตโนมัติ เจ้าหน้าที่จะตรวจสอบให้โดยตรงค่ะ"
      };
    }

    if (evalResult.reasonCode === "LATE_PAYMENT_REVIEW") {
      if (repository.updatePayment) {
        await repository.updatePayment(paymentId, {
          status: PAYMENT_STATUSES.manualReview,
          updated_at: nowDate.toISOString()
        });
      }
      session.stage = "payment_manual_review";
      return {
        success: false,
        code: "LATE_PAYMENT_MANUAL_REVIEW",
        route: "LATE_PAYMENT_MANUAL_REVIEW",
        stage: "payment_manual_review",
        message: "รายการนี้มีการชำระเงินเข้ามาล่าช้าหลังหมดเวลาจอง ระบบได้บันทึกหลักฐานและส่งต่อให้เจ้าหน้าที่ตรวจสอบเพื่อดูแลการคืนเงินหรือจัดสรรคิวใหม่ค่ะ"
      };
    }

    if (evalResult.reasonCode === "AMOUNT_MISMATCH_UNDERPAID") {
      session.stage = "payment_pending";
      return {
        success: false,
        code: "AMOUNT_MISMATCH",
        stage: "payment_pending",
        message: `ยอดเงินในสลิป (฿${verificationResult.verified_amount}) ไม่ตรงกับยอดที่ต้องชำระ (฿${expectedAmount}) กรุณาส่งสลิปที่ถูกต้องใหม่อีกครั้งค่ะ`
      };
    }

    if (evalResult.reasonCode === "OVERPAYMENT_MANUAL_REVIEW") {
      if (repository.updatePayment) {
        await repository.updatePayment(paymentId, {
          status: PAYMENT_STATUSES.manualReview,
          updated_at: nowDate.toISOString()
        });
      }
      session.stage = "payment_manual_review";
      return {
        success: false,
        code: "OVERPAYMENT",
        stage: "payment_manual_review",
        message: "ยอดเงินในสลิปเกินจำนวนที่ต้องชำระ ระบบส่งให้ทางร้านตรวจสอบค่ะ"
      };
    }

    if (evalResult.reasonCode === "RECEIVER_MISMATCH") {
      if (repository.updatePayment) {
        await repository.updatePayment(paymentId, {
          status: PAYMENT_STATUSES.manualReview,
          updated_at: nowDate.toISOString()
        });
      }
      session.stage = "payment_failed";
      return {
        success: false,
        code: "RECEIVER_MISMATCH",
        stage: "payment_failed",
        message: "บัญชีผู้รับเงินไม่ตรงกับบัญชีของทางร้าน กรุณาตรวจสอบค่ะ"
      };
    }

    if (evalResult.reasonCode === "DUPLICATE_TRANSACTION") {
      if (repository.updatePayment) {
        await repository.updatePayment(paymentId, {
          status: PAYMENT_STATUSES.verificationFailed,
          updated_at: nowDate.toISOString()
        });
      }
      session.stage = "payment_failed";
      return {
        success: false,
        code: "DUPLICATE_TRANSACTION",
        stage: "payment_failed",
        message: "สลิปนี้เคยถูกใช้งานไปแล้ว ไม่สามารถใช้ซ้ำได้ค่ะ"
      };
    }

    if (evalResult.reasonCode === "INVALID_SLIP") {
      session.stage = "payment_pending";
      return {
        success: false,
        code: "INVALID_SLIP",
        stage: "payment_pending",
        message: "ไม่สามารถอ่านข้อมูลในสลิปได้ กรุณาส่งรูปสลิปใหม่อีกครั้งค่ะ"
      };
    }

    // General verification failure fallback
    session.stage = "payment_failed";
    return {
      success: false,
      code: evalResult.reasonCode || "VERIFICATION_FAILED",
      stage: "payment_failed",
      message: evalResult.description || "ตรวจสอบสลิปไม่สำเร็จ กรุณาส่งรูปใหม่อีกครั้งค่ะ"
    };
  }

  /**
   * Processes a direct authoritative verification notification (e.g. from webhook or external async query).
   * Ensures authoritative confirmation gate, records attempt evidence, prevents reclaims of released slots,
   * and routes late payments safely to LATE_PAYMENT_MANUAL_REVIEW.
   */
  static async processAuthoritativeNotification(repository, {
    paymentId,
    verificationResult,
    expectedReceiver = null,
    entitlements = {},
    providerCapabilities = null,
    now = new Date()
  }) {
    const nowDate = now instanceof Date ? now : new Date(now);
    const payment = await (
      repository.getPaymentById?.(paymentId) ??
      repository.getPaymentForUpdate?.(paymentId)
    );
    if (!payment) {
      throw new Error(`Payment ${paymentId} not found for authoritative notification`);
    }

    const booking = await (
      repository.getBookingById?.(payment.original_booking_id) ??
      repository.getBooking?.(payment.original_booking_id)
    );

    const attemptId = randomUUID();
    const verifiedAmount = verificationResult.amountSatang !== undefined
      ? (verificationResult.amountSatang / 100)
      : (verificationResult.verified_amount || 0);

    const evalResult = evaluateSlipVerification({
      payment,
      verificationResult,
      expectedReceiver: expectedReceiver || payment.business_id,
      options: {
        capabilities: providerCapabilities || verificationResult.capabilities
      }
    });

    const isAuthoritative = verificationResult.authoritative === true;
    const isVerified = verificationResult.verified === true;
    const isLatePayment = (booking && booking.status !== "pending") ||
      payment.status === PAYMENT_STATUSES.expired ||
      evalResult.reasonCode === "LATE_PAYMENT_REVIEW";

    // Check slot collision if booking or slot was released/re-allocated
    let slotTakenByOther = false;
    if (booking && repository.findConflictingActiveBooking) {
      const conflict = await repository.findConflictingActiveBooking(
        booking.staff_id,
        booking.start_at,
        booking.end_at,
        booking.id
      );
      if (conflict) {
        slotTakenByOther = true;
      }
    }

    // Format receiver and sender as safe text strings for database column constraints
    const receiverStr = typeof verificationResult.receiver === "object" && verificationResult.receiver !== null
      ? (verificationResult.receiver.merchantIdentifier || verificationResult.receiver.promptPayIdentifierMasked || verificationResult.receiver.accountNumberMasked || verificationResult.receiver.accountName || "merchant")
      : (verificationResult.receiver || null);

    const senderStr = typeof verificationResult.sender === "object" && verificationResult.sender !== null
      ? (verificationResult.sender.accountNumberMasked || verificationResult.sender.accountName || "sender")
      : (verificationResult.sender || null);

    // Map to allowed DB normalized_result enum values:
    // ('success', 'amount_mismatch', 'overpaid', 'receiver_mismatch', 'duplicate', 'provider_error', 'invalid_slip')
    let dbNormalizedResult = "provider_error";
    if (isVerified && isAuthoritative) {
      dbNormalizedResult = "success";
    } else if (evalResult.reasonCode === "AMOUNT_MISMATCH_UNDERPAID" || evalResult.reasonCode === "AMOUNT_MISMATCH") {
      dbNormalizedResult = "amount_mismatch";
    } else if (evalResult.reasonCode === "OVERPAYMENT" || evalResult.reasonCode === "OVERPAYMENT_MANUAL_REVIEW") {
      dbNormalizedResult = "overpaid";
    } else if (evalResult.reasonCode === "RECEIVER_MISMATCH") {
      dbNormalizedResult = "receiver_mismatch";
    } else if (evalResult.reasonCode === "DUPLICATE_TRANSACTION") {
      dbNormalizedResult = "duplicate";
    } else if (evalResult.reasonCode === "INVALID_SLIP" || !isVerified) {
      dbNormalizedResult = "invalid_slip";
    }

    let safeTxnAt = null;
    if (verificationResult.transactionAt) {
      const parsed = new Date(verificationResult.transactionAt);
      if (!Number.isNaN(parsed.getTime())) {
        safeTxnAt = parsed.toISOString();
      }
    }

    // Persist PaymentAttempt evidence of authoritative transaction
    await recordPaymentAttempt(repository, {
      id: attemptId,
      payment_id: payment.id,
      attempt_type: "gateway_callback",
      verification_provider: verificationResult.provider || "authoritative_slip",
      provider_request_id: verificationResult.providerRequestId || null,
      provider_status: isVerified ? "completed" : "failed",
      normalized_result: dbNormalizedResult,
      verified_amount: verifiedAmount,
      verified_receiver: receiverStr,
      verified_sender: senderStr,
      verified_transaction_reference: verificationResult.transactionReference || null,
      verified_transaction_at: safeTxnAt,
      failure_reason_code: (isLatePayment || slotTakenByOther)
        ? "LATE_PAYMENT_REVIEW"
        : (evalResult.reasonCode || null),
      created_at: nowDate.toISOString()
    });

    // If late payment or slot taken: NEVER confirm original booking, NEVER touch other booking
    if (isLatePayment || slotTakenByOther) {
      if (repository.updatePayment) {
        await repository.updatePayment(payment.id, {
          status: PAYMENT_STATUSES.manualReview,
          updated_at: nowDate.toISOString()
        });
      }
      return {
        success: false,
        code: "LATE_PAYMENT_MANUAL_REVIEW",
        route: "LATE_PAYMENT_MANUAL_REVIEW",
        payment,
        booking,
        evidence: {
          transactionReference: verificationResult.transactionReference,
          amountSatang: verificationResult.amountSatang,
          verifiedAmount
        }
      };
    }

    // If not eligible for auto confirmation (e.g. non-authoritative, mismatch, overpayment)
    if (!evalResult.eligibleForAutoConfirmation) {
      if (repository.updatePayment) {
        await repository.updatePayment(payment.id, {
          status: evalResult.recommendedStatus,
          updated_at: nowDate.toISOString()
        });
      }
      return {
        success: false,
        code: evalResult.reasonCode,
        recommendedStatus: evalResult.recommendedStatus,
        payment,
        booking
      };
    }

    // Strict Fail-Closed Financial Entitlement Check:
    // Both slipVerification AND autoPaymentConfirmation MUST be strictly true.
    // Any other value (false, undefined, null, error) halts auto-confirm and routes to manual_review.
    const slipVerificationAllowed = entitlements?.slipVerification === true;
    const autoConfirmAllowed = entitlements?.autoPaymentConfirmation === true;

    if (!slipVerificationAllowed || !autoConfirmAllowed) {
      if (repository.updatePayment) {
        await repository.updatePayment(payment.id, {
          status: PAYMENT_STATUSES.manualReview,
          updated_at: nowDate.toISOString()
        });
      }
      return {
        success: false,
        code: PAYMENT_REASON_CODES.ENTITLEMENT_NOT_GRANTED,
        recommendedStatus: PAYMENT_STATUSES.manualReview,
        payment,
        booking
      };
    }

    // Auto-confirm atomically
    const confirmResult = await confirmVerifiedPayment(repository, {
      paymentId: payment.id,
      verifiedAmount,
      transactionNamespace: verificationResult.transactionNamespace || "promptpay_qr",
      transactionReference: verificationResult.transactionReference,
      actor: "authoritative_provider",
      now: nowDate
    });

    return {
      success: true,
      code: "PAYMENT_CONFIRMED",
      payment: confirmResult.payment,
      booking: confirmResult.booking
    };
  }
}

module.exports = {
  SlipIntakeService,
  processSlip: SlipIntakeService.processSlip,
  processAuthoritativeNotification: SlipIntakeService.processAuthoritativeNotification
};
