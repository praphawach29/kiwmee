// Salon Booking OS v1 - Booking Checkout Service (Payment Orchestration Layer)
// Connects Booking Creation Flow with Payment Policy Resolution and Slot Hold.
// Invariant: Production defaults to no_payment (100% existing confirmation behavior)
// unless payment/deposit features and policies are explicitly enabled.

const { PAYMENT_TYPES } = require("./pricing-calculator");
const { toSatang } = require("./money");
const { resolvePaymentPolicy } = require("./payment-policy-resolver");
const {
  DEFAULT_PAYMENT_EXPIRY_MINUTES,
  createPendingBookingWithPayment
} = require("./payment-service");
const { createBooking } = require("../automation/booking-orchestration");
const { getBusinessPaymentPolicy } = require("../config");

/**
 * Formats the standard Payment Pending Result Contract.
 * Strict boundary: never leaks credentials, provider secrets, or raw internal metadata.
 */
function formatPaymentPendingResult({ booking, payment, isExisting = false }) {
  const amountDue = Number(payment.amount_due);
  const amountDueSatang = toSatang(payment.amount_due);

  return {
    mode: "payment_required",
    status: "payment_pending",
    isExisting,
    bookingId: booking.id,
    paymentId: payment.id,
    amountDue,
    currency: payment.currency || "THB",
    expiresAt: payment.expires_at,
    verificationDeadline: payment.verification_deadline || null,
    booking: {
      id: booking.id,
      status: booking.status
    },
    payment: {
      id: payment.id,
      type: payment.payment_type,
      amountDueSatang,
      currency: payment.currency || "THB",
      expiresAt: payment.expires_at,
      verificationDeadline: payment.verification_deadline || null
    }
  };
}

class BookingCheckoutService {
  /**
   * Orchestrates booking checkout:
   * 1. Check idempotency for existing payment/booking.
   * 2. Resolve active payment policy against capabilities and settings.
   * 3. Route to:
   *    - Path A: no_payment -> existing booking confirmation flow (confirmed status, outbox jobs)
   *    - Path B: payment_required -> create pending booking + payment intent + active allocation + hold slot
   */
  static async checkout(repository, input, options = {}) {
    const businessId = options.businessId || input.business_id || input.businessId || "default";
    const idempotencyKey = options.idempotencyKey || input.idempotency_key || input.idempotencyKey || null;

    // 1. Idempotency Check: if key provided and already exists, return existing record
    if (idempotencyKey) {
      // 1.1 Check booking idempotency (supports no_payment and payment_required)
      const existingBooking = await repository.findBookingByIdempotencyKey?.(idempotencyKey);
      if (existingBooking) {
        const existingPayment = await (
          repository.findPaymentByBookingId?.(existingBooking.id) ??
          repository.findPaymentByIdempotencyKey?.(idempotencyKey)
        );
        if (existingPayment) {
          return formatPaymentPendingResult({
            booking: existingBooking,
            payment: existingPayment,
            isExisting: true
          });
        }
        return {
          mode: "no_payment",
          status: existingBooking.status,
          booking: existingBooking,
          payment: null,
          isExisting: true
        };
      }

      // 1.2 Check payment idempotency (existing payment_required behavior)
      const existingPayment = await repository.findPaymentByIdempotencyKey?.(idempotencyKey);
      if (existingPayment) {
        const existingBooking = await (
          repository.getBooking?.(existingPayment.original_booking_id) ??
          repository.getBookingById?.(existingPayment.original_booking_id) ??
          repository.getBookingForUpdate?.(existingPayment.original_booking_id)
        );
        if (existingBooking) {
          return formatPaymentPendingResult({
            booking: existingBooking,
            payment: existingPayment,
            isExisting: true
          });
        }
      }
    }

    // 2. Lookup service details for pricing and policy override
    const serviceId = input.service_id ?? input.serviceId;
    const service = await repository.getActiveService(serviceId);
    if (!service) {
      throw new Error("service not found or inactive");
    }

    const servicePrice = options.servicePrice ?? input.service_price ?? service.price ?? 500;
    const effectiveServicePolicy = options.serviceSettings || options.servicePolicy || service.payment_policy;
    const effectiveBusinessPolicy = options.businessSettings || options.businessPolicy || getBusinessPaymentPolicy();

    // 3. Resolve active payment policy
    const resolvedPolicy = await resolvePaymentPolicy({
      businessSettings: effectiveBusinessPolicy,
      serviceSettings: effectiveServicePolicy,
      entitlements: options.entitlements,
      hasFeatureFn: options.hasFeatureFn,
      businessId
    });

    // 4. PATH A: no_payment -> execute existing booking confirmation flow unchanged
    if (resolvedPolicy.payment_type === PAYMENT_TYPES.noPayment) {
      try {
        const booking = await createBooking(repository, {
          ...input,
          checkout_idempotency_key: idempotencyKey
        }, options);
        return {
          mode: "no_payment",
          status: "confirmed",
          booking,
          payment: null,
          isExisting: false
        };
      } catch (err) {
        if (idempotencyKey && (
          err.code === "BOOKING_IDEMPOTENCY_CONFLICT" ||
          err.code === "PAYMENT_IDEMPOTENCY_CONFLICT" ||
          err.message?.includes("not available") ||
          err.message?.includes("overlap")
        )) {
          const existingBooking = await repository.findBookingByIdempotencyKey?.(idempotencyKey);
          if (existingBooking) {
            return {
              mode: "no_payment",
              status: existingBooking.status,
              booking: existingBooking,
              payment: null,
              isExisting: true
            };
          }
        }
        throw err;
      }
    }

    // 5. PATH B: payment_required -> atomic pending booking + payment + slot hold
    const provider = options.provider || "promptpay_qr";
    const now = options.now || new Date();
    const expiryMinutes = options.expiryMinutes || DEFAULT_PAYMENT_EXPIRY_MINUTES;

    try {
      const result = await createPendingBookingWithPayment(repository, {
        businessId,
        customer: input.customer,
        serviceId,
        staffId: input.staff_id ?? input.staffId,
        startAt: input.start_at ?? input.startAt,
        servicePrice,
        source: input.source ?? "web",
        notes: input.notes ?? null,
        paymentPolicy: resolvedPolicy,
        provider,
        idempotencyKey,
        expiryMinutes,
        now
      });

      return formatPaymentPendingResult({
        booking: result.booking,
        payment: result.payment,
        isExisting: false
      });
    } catch (err) {
      if (idempotencyKey && (
        err.code === "BOOKING_IDEMPOTENCY_CONFLICT" ||
        err.code === "PAYMENT_IDEMPOTENCY_CONFLICT" ||
        err.message?.includes("not available") ||
        err.message?.includes("overlap")
      )) {
        const existingPayment = await repository.findPaymentByIdempotencyKey?.(idempotencyKey);
        if (existingPayment) {
          const existingBooking = await (
            repository.getBooking?.(existingPayment.original_booking_id) ??
            repository.getBookingById?.(existingPayment.original_booking_id) ??
            repository.getBookingForUpdate?.(existingPayment.original_booking_id)
          );
          if (existingBooking) {
            return formatPaymentPendingResult({
              booking: existingBooking,
              payment: existingPayment,
              isExisting: true
            });
          }
        }
        const existingBooking = await repository.findBookingByIdempotencyKey?.(idempotencyKey);
        if (existingBooking) {
          const existingPay = await (
            repository.findPaymentByBookingId?.(existingBooking.id) ??
            repository.findPaymentByIdempotencyKey?.(idempotencyKey)
          );
          if (existingPay) {
            return formatPaymentPendingResult({
              booking: existingBooking,
              payment: existingPay,
              isExisting: true
            });
          }
        }
      }
      throw err;
    }
  }
}

// Global convenience wrapper
async function checkoutBooking(repository, input, options = {}) {
  return BookingCheckoutService.checkout(repository, input, options);
}

module.exports = {
  BookingCheckoutService,
  BookingPaymentOrchestrator: BookingCheckoutService,
  checkoutBooking,
  formatPaymentPendingResult
};
