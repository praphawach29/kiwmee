// The membership card's looks (loyalty_tiers.card_theme, migration …003000): the same colours on the
// member's LINE page, the shop's preview and the "you moved up" LINE card.
const TIER_THEMES = {
  classic: { label: "คลาสสิก", from: "#6A4CFF", to: "#2E1A9E", text: "#FFFFFF", accent: "#3DDC97" },
  silver: { label: "เงิน", from: "#E3E7EE", to: "#8D96A5", text: "#1B1640", accent: "#4F5B6E" },
  gold: { label: "ทอง", from: "#F2D27A", to: "#A8772B", text: "#2B1D05", accent: "#7A4F0D" },
  platinum: { label: "แพลทินัม", from: "#A9C1D3", to: "#3B5163", text: "#FFFFFF", accent: "#DDEBF5" },
  black: { label: "แบล็ก", from: "#3A3746", to: "#0B0A10", text: "#F3E7C2", accent: "#D9B865" }
};

const themeOf = (id) => TIER_THEMES[id] ?? TIER_THEMES.classic;

module.exports = { TIER_THEMES, themeOf };
