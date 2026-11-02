// What a venue or shop offers its customers (migration …002400): a fixed list, so every shop's
// icons look alike and the customer page can show them without the shop uploading anything.
// The same codes are checked by the database (businesses_amenities_check).

const AMENITIES = [
  { code: "parking", icon: "🚗", label: "ที่จอดรถ" },
  { code: "lights", icon: "💡", label: "ไฟส่องสว่าง" },
  { code: "indoor", icon: "🏠", label: "ในร่ม / มีหลังคา" },
  { code: "aircon", icon: "❄️", label: "ห้องแอร์" },
  { code: "shower", icon: "🚿", label: "ห้องอาบน้ำ" },
  { code: "toilet", icon: "🚻", label: "ห้องน้ำ" },
  { code: "changing", icon: "👕", label: "ห้องแต่งตัว" },
  { code: "locker", icon: "🔐", label: "ล็อกเกอร์" },
  { code: "water", icon: "💧", label: "น้ำดื่ม" },
  { code: "food", icon: "🥤", label: "อาหาร / เครื่องดื่ม" },
  { code: "rental", icon: "🎾", label: "ให้เช่าอุปกรณ์" },
  { code: "ball", icon: "⚽", label: "มีลูกบอลให้" },
  { code: "seats", icon: "🪑", label: "ที่นั่งพัก" },
  { code: "wifi", icon: "📶", label: "Wi-Fi" },
  { code: "cctv", icon: "📹", label: "กล้องวงจรปิด" },
  { code: "first_aid", icon: "🩹", label: "ชุดปฐมพยาบาล" }
];

const AMENITY_CODES = AMENITIES.map((a) => a.code);

/** The shop's codes in the list's order, unknown ones dropped (for showing) */
function amenityList(codes) {
  const set = new Set(Array.isArray(codes) ? codes : []);
  return AMENITIES.filter((a) => set.has(a.code));
}

module.exports = { AMENITIES, AMENITY_CODES, amenityList };
