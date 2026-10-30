// Navigation mirrors existing shop-route permissions; the backend remains the authority.
const DAILY = [
  { id: "bookings", label: "การจอง", icon: "▦" },
  { id: "bills", label: "บิลและรายรับ", icon: "▤" },
];
const SETTINGS = [
  { id: "flow", label: "ขั้นตอนจอง", icon: "⇄" },
  { id: "offerings", label: "บริการและราคา", icon: "◈" },
  { id: "resources", label: "ช่าง / สนาม", icon: "♧" },
  { id: "hours", label: "ร้านและเวลาทำการ", icon: "◷" },
];

export function shopTabs(role) {
  return shopNavigation(role).flatMap((group) => group.items).filter((item) => !item.href);
}

// Unknown roles have no default operational tab. Never render a requested tab unchecked.
export function resolveShopTab(role, requested) {
  const tabs = shopTabs(role);
  return tabs.find((item) => item.id === requested)?.id ?? tabs[0]?.id ?? null;
}

// null means an auth callback hash: leave it untouched for the session handler.
export function homeTabFromHash(hash) {
  const params = new URLSearchParams(hash.replace(/^#/, ""));
  if (["access_token", "refresh_token", "error", "error_description", "type"].some((key) => params.has(key))) return null;
  return hash === "#merchant-create" ? "create" : "shops";
}

export function shopNavigation(role) {
  return [
    { label: "ภาพรวม", items: [{ id: "shops", icon: "⌂", label: "ร้านทั้งหมด", href: "/dashboard" }] },
    ...(role === "owner" || role === "staff" ? [{ label: "จัดการประจำวัน", items: DAILY }] : []),
    ...(role === "owner" ? [{ label: "ตั้งค่าร้าน", collapsible: true, items: SETTINGS }] : []),
  ];
}
