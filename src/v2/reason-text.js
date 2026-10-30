// Customer-facing wording for the reason codes the booking RPCs raise (message of BK404/BK409/BK422).
// Shared by the public booking page and the customer self-service page.

const REASON_TEXT = {
  NOT_FOUND: "ไม่พบการจองนี้ ลิงก์อาจไม่ถูกต้อง",
  CUSTOMER_CHANGE_OFF: "ร้านนี้ไม่เปิดให้เปลี่ยนการจองเองทางออนไลน์ กรุณาติดต่อร้าน",
  TOO_LATE_TO_CHANGE: "ใกล้เวลานัดเกินกว่าจะเปลี่ยนเองได้แล้ว กรุณาติดต่อร้าน",
  NOT_CHANGEABLE: "การจองนี้เปลี่ยนไม่ได้แล้ว",
  HOLD_EXPIRED: "การจองนี้หมดเวลารอชำระเงินแล้ว",
  FULLY_BOOKED: "เวลานี้เพิ่งถูกจองไป กรุณาเลือกเวลาอื่น",
  BUSINESS_CLOSED: "ร้านปิดในวันหรือเวลานั้น",
  STAFF_OFF: "ช่างที่คุณเลือกไม่อยู่ในเวลานั้น",
  NO_WORKING_WINDOW: "เวลานี้อยู่นอกเวลาทำการ",
  PAST_WORKING_HOURS: "เลยเวลาที่รับจองแล้ว",
  OUTSIDE_BOOKING_WINDOW: "วันนี้ยังไม่เปิดให้จอง หรือผ่านไปแล้ว",
  INVALID_TIME: "เวลาเริ่มไม่ตรงกับช่วงเวลาของร้าน",
  NOT_OFFERED: "บริการนี้ไม่มีในเวลานั้น",
  CUSTOMER_NAME_REQUIRED: "กรุณากรอกชื่อ",
  INVALID_DURATION: "ระยะเวลาที่เลือกไม่ถูกต้อง",
  INVALID_PARTY_SIZE: "จำนวนคนไม่ถูกต้อง",
  NOT_IN_PAST: "เวลานี้ยังไม่ผ่านไป"
};

module.exports = { REASON_TEXT };
