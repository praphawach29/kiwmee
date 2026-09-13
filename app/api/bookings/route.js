const { createBooking } = require("../../../src/automation/booking-orchestration");
const { json, readJson, route } = require("../../../src/http");
const { getRepository } = require("../../../src/repositories");
const { validateCreateBookingPayload } = require("../../../src/validation");
const { logEvent } = require("../../../src/observability/logger");
const { BookingCheckoutService } = require("../../../src/payment/booking-checkout-service");

async function POST(request) {
  return route(async () => {
    const payload = validateCreateBookingPayload(await readJson(request));
    try {
      const result = await BookingCheckoutService.checkout(getRepository(), payload, {
        businessId: payload.business_id || "default",
        idempotencyKey: payload.checkout_idempotency_key || payload.idempotency_key
      });

      logEvent("booking_created", {
        booking_id: result.booking?.id,
        channel: payload.source,
        mode: result.mode,
        status: result.status
      });

      if (result.mode === "payment_required" && result.payment) {
        return json({
          ...result.booking,
          mode: result.mode,
          amount_due: result.amountDue,
          currency: result.currency,
          payment: {
            id: result.payment.id,
            type: result.payment.type,
            amountDueSatang: result.payment.amountDueSatang,
            currency: result.payment.currency,
            expiresAt: result.payment.expiresAt,
            verificationDeadline: result.payment.verificationDeadline
          }
        }, 201);
      }

      return json({
        ...result.booking,
        mode: result.mode
      }, 201);
    } catch (error) {
      if (/not available|overlap|conflict/i.test(error.message ?? "")) logEvent("booking_conflict", { code: "CONFLICT", channel: payload.source });
      throw error;
    }
  });
}

module.exports = { POST };
