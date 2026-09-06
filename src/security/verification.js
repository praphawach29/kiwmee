const { timingSafeEqual } = require("node:crypto");
function normalizePhone(value) {
  if (typeof value !== "string" || !/^[+\d ()-]{9,24}$/.test(value)) return "";
  return value.replace(/\D/g, "");
}
function equal(a, b) {
  const left = Buffer.from(a); const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
class VerificationProvider { async verifyBooking() { throw new Error("verifyBooking must be implemented"); } }
class PhoneMatchVerificationProvider extends VerificationProvider {
  async verifyBooking({ repository, bookingId, proof }) {
    const phone = normalizePhone(proof?.phone); if (!phone) return false;
    const booking = await repository.getBookingDetail(bookingId);
    const expected = normalizePhone(booking?.customer?.phone);
    return Boolean(expected && equal(phone, expected));
  }
}
module.exports = { VerificationProvider, PhoneMatchVerificationProvider, normalizePhone };
