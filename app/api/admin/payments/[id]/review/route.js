// Salon Booking OS v1 - Admin Payment Review Action API
const { json, route } = require("../../../../../../src/http");
const { getRepository } = require("../../../../../../src/repositories");
const { requireAdmin } = require("../../../../../../src/security/access");
const { boundedJson, sameOrigin } = require("../../../../../../src/security/limits");
const { AppError } = require("../../../../../../src/errors");
const {
  getPaymentReviewDetails,
  approvePaymentReview,
  rejectPaymentReview,
  PaymentReviewError
} = require("../../../../../../src/payment");

async function GET(request, { params }) {
  return route(async () => {
    const session = await requireAdmin(request);
    const resolvedParams = await params;
    const paymentId = resolvedParams.id;
    const repository = getRepository();
    const tenantId = session.business_id || session.tenant_id || request.headers.get("x-business-id") || null;

    try {
      const review = await getPaymentReviewDetails(repository, { paymentId, tenantId });
      return json({ review });
    } catch (err) {
      if (err instanceof PaymentReviewError && err.code === "PAYMENT_NOT_FOUND") {
        throw new AppError("NOT_FOUND", "ไม่พบรายการชำระเงินนี้", 404);
      }
      if (err instanceof PaymentReviewError && err.code === "TENANT_ISOLATION_VIOLATION") {
        throw new AppError("FORBIDDEN", "ไม่มีสิทธิ์เข้าถึงรายการชำระเงินของร้านอื่น", 403);
      }
      throw err;
    }
  });
}

async function POST(request, { params }) {
  return route(async () => {
    sameOrigin(request);
    const session = await requireAdmin(request);
    const resolvedParams = await params;
    const paymentId = resolvedParams.id;
    const body = await boundedJson(request);
    const repository = getRepository();

    const action = body.action;
    const adminIdentity = session.id ? `admin_${session.id.slice(0, 8)}` : "admin";
    const tenantId = session.business_id || session.tenant_id || request.headers.get("x-business-id") || null;

    try {
      if (action === "approve") {
        const result = await approvePaymentReview(repository, {
          paymentId,
          tenantId,
          reviewedBy: adminIdentity,
          notes: body.notes ?? null
        });
        return json({ success: true, action: "approve", result });
      } else if (action === "reject") {
        const result = await rejectPaymentReview(repository, {
          paymentId,
          tenantId,
          reviewedBy: adminIdentity,
          reasonCode: body.reasonCode || "STAFF_MANUAL_REJECTION",
          notes: body.notes ?? null,
          expireBooking: Boolean(body.expireBooking)
        });
        return json({ success: true, action: "reject", result });
      } else {
        throw new AppError("BAD_REQUEST", `Invalid review action '${action}'`, 400);
      }
    } catch (err) {
      if (err instanceof PaymentReviewError) {
        if (err.code === "TENANT_ISOLATION_VIOLATION") {
          throw new AppError("FORBIDDEN", "ไม่มีสิทธิ์จัดการรายการชำระเงินของร้านอื่น", 403);
        }
        if (err.code === "MANUAL_REVIEW_LATE_PAYMENT") {
          throw new AppError("MANUAL_REVIEW_LATE_PAYMENT", "ไม่สามารถยืนยันได้เนื่องจากช่วงเวลาจองหมดอายุหรือถูกจองโดยรายการอื่นแล้ว", 409);
        }
        if (err.code === "PAYMENT_NOT_FOUND" || err.code === "BOOKING_NOT_FOUND") {
          throw new AppError("NOT_FOUND", err.message, 404);
        }
        throw new AppError(err.code, err.message, 400);
      }
      throw err;
    }
  });
}

module.exports = { GET, POST };
