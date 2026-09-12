// Salon Booking OS v1 - Admin Payments Manual Review Queue API
const { json, route } = require("../../../../src/http");
const { getRepository } = require("../../../../src/repositories");
const { requireAdmin } = require("../../../../src/security/access");
const { computeTransRefFingerprint, maskAccountNumber } = require("../../../../src/payment");

async function GET(request) {
  return route(async () => {
    await requireAdmin(request);
    const repository = getRepository();
    const rows = await repository.listPaymentsForManualReview();

    // Map each item to safe sanitized view without leaking sensitive secrets
    const payments = await Promise.all(rows.map(async (row) => {
      const attempts = await (repository.getPaymentAttempts ? repository.getPaymentAttempts(row.payment_id) : []);
      const latestAttempt = attempts.length > 0 ? attempts[attempts.length - 1] : null;

      const createdAtMs = new Date(row.payment_created_at).getTime();
      const ageMinutes = Math.max(0, Math.floor((Date.now() - createdAtMs) / (60 * 1000)));

      let receiverMatchStatus = "UNKNOWN";
      if (latestAttempt) {
        if (latestAttempt.normalized_result === "receiver_mismatch") {
          receiverMatchStatus = "MISMATCH";
        } else if (latestAttempt.failure_reason_code === "INSUFFICIENT_RECEIVER_DATA") {
          receiverMatchStatus = "INSUFFICIENT";
        } else if (latestAttempt.verified_receiver) {
          receiverMatchStatus = "MATCH";
        }
      }

      const duplicateStatus = latestAttempt
        ? (latestAttempt.normalized_result === "duplicate" || latestAttempt.provider_status === "DUPLICATE" ? "DUPLICATE" : "CLEAN")
        : "NONE";

      return {
        payment_id: row.payment_id,
        booking_id: row.booking_id,
        booking_reference: `#${String(row.booking_id).slice(0, 8).toUpperCase()}`,
        customer_name: row.customer_name ?? "ลูกค้า",
        service_name: row.service_name ?? "-",
        staff_name: row.staff_name ?? "-",
        appointment_start: row.start_at,
        appointment_end: row.end_at,
        amount_due: row.amount_due,
        verified_amount: latestAttempt?.verified_amount ?? null,
        receiver_match_status: receiverMatchStatus,
        transaction_time: latestAttempt?.verified_transaction_at ?? null,
        provider: latestAttempt?.verification_provider ?? row.provider,
        provider_status: latestAttempt?.provider_status ?? "pending",
        duplicate_status: duplicateStatus,
        payment_age_minutes: ageMinutes,
        review_status: row.review_status ?? "pending"
      };
    }));

    return json({ payments });
  });
}

module.exports = { GET };
