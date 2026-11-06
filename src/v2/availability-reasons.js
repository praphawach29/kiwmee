// เหตุผลที่คิวว่างเป็นศูนย์ — ใช้ร่วมกับ engine คิวว่างของ v2 (ย้ายมาจาก availability-engine ของ v1
// ตอนปลดระวางโค้ด v1; ค่าเดิมทุกตัวเพื่อไม่ให้ข้อความ/รหัสเปลี่ยน)
const ZERO_AVAILABILITY_REASONS = {
  PAST_WORKING_HOURS: "PAST_WORKING_HOURS",
  BUSINESS_CLOSED: "BUSINESS_CLOSED",
  STAFF_OFF: "STAFF_OFF",
  FULLY_BOOKED: "FULLY_BOOKED",
  NO_WORKING_WINDOW: "NO_WORKING_WINDOW",
  NO_AVAILABLE_SLOTS: "NO_AVAILABLE_SLOTS"
};

module.exports = { ZERO_AVAILABILITY_REASONS };
