// Booking cards sent to the customer's LINE through Kiwmee's central Official Account
// (docs/LOYALTY_DESIGN.md: one OA for every shop at first). Only customers who booked inside LINE
// (LIFF, so we know their LINE user id) get them, and LINE delivers only to people who added the OA
// as a friend. A card that cannot be sent never fails the booking: the result says why instead.
//
//   bookingCard(...)  → a Flex message (pure, unit-tested)
//   pushLine(db, to, messages)  → { sent, status?, reason? } with the token saved in /super

const crypto = require("node:crypto");
const { getSetting } = require("./platform-settings");

const GRAPE = "#6A4CFF";
const INK = "#1B1640";
const MUTED = "#5F5A7A";
const MINT = "#0B7A50";
const WARN = "#B54708";

const baht = (n) => `${Number(n).toLocaleString("th-TH")} บาท`;

function whenText(startAt, endAt, timezone) {
  const day = new Intl.DateTimeFormat("th-TH", { timeZone: timezone, weekday: "long", day: "numeric", month: "long", year: "numeric" }).format(new Date(startAt));
  const time = (iso) => new Intl.DateTimeFormat("th-TH", { timeZone: timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(iso));
  return { day, time: endAt ? `${time(startAt)}–${time(endAt)} น.` : `${time(startAt)} น.`, clock: time };
}

const row = (label, value, { bold = false, color = INK } = {}) => ({
  type: "box",
  layout: "horizontal",
  spacing: "md",
  contents: [
    { type: "text", text: label, size: "sm", color: MUTED, flex: 2 },
    { type: "text", text: String(value), size: "sm", color, flex: 5, wrap: true, align: "end", weight: bold ? "bold" : "regular" }
  ]
});

const KINDS = {
  booked: { title: "จองสำเร็จ", color: MINT, button: "ดู เลื่อน หรือยกเลิกนัด" },
  held: { title: "กันคิวไว้ให้แล้ว", color: WARN, button: "แนบสลิปโอนมัดจำ" },
  confirmed: { title: "ร้านยืนยันคิวแล้ว", color: MINT, button: "ดูการจองของฉัน" }
};

/**
 * kind: booked | held (waiting for a transfer deposit) | confirmed (the shop confirmed the deposit)
 * booking: { offering, startAt, endAt, resources: [names], addons: [{ name, quantity }], total,
 *            deposit: { due, holdExpiresAt } | null }
 * link: where the button goes (the customer's own booking page), or null for no button
 */
function bookingCard({ kind, shop, booking, link }) {
  const k = KINDS[kind] ?? KINDS.booked;
  const when = whenText(booking.startAt, booking.endAt, shop.timezone);
  const rows = [row("วัน", when.day), row("เวลา", when.time, { bold: true })];
  if (booking.resources?.length) rows.push(row("ช่าง/ที่", booking.resources.join(", ")));
  if (booking.addons?.length) rows.push(row("เพิ่มเติม", booking.addons.map((a) => `${a.name}${a.quantity > 1 ? ` ×${a.quantity}` : ""}`).join(", ")));
  if (booking.total > 0) rows.push(row("ราคา", baht(booking.total), { bold: true }));

  const body = [
    { type: "text", text: shop.name, weight: "bold", size: "lg", color: INK, wrap: true },
    { type: "text", text: booking.offering, size: "md", color: INK, wrap: true, margin: "sm" },
    { type: "separator", margin: "lg" },
    { type: "box", layout: "vertical", spacing: "sm", margin: "lg", contents: rows }
  ];
  if (kind === "held" && booking.deposit) {
    const by = booking.deposit.holdExpiresAt ? ` ภายใน ${when.clock(booking.deposit.holdExpiresAt)} น.` : "";
    body.push({
      type: "box",
      layout: "vertical",
      margin: "lg",
      paddingAll: "md",
      backgroundColor: "#FFF4E5",
      cornerRadius: "md",
      contents: [{ type: "text", text: `โอนมัดจำ ${baht(booking.deposit.due)}${by} แล้วแนบสลิป ไม่อย่างนั้นคิวจะถูกปล่อย`, size: "sm", color: WARN, wrap: true }]
    });
  }

  const bubble = {
    type: "bubble",
    header: {
      type: "box",
      layout: "vertical",
      paddingAll: "lg",
      backgroundColor: GRAPE,
      contents: [{ type: "text", text: k.title, color: "#FFFFFF", weight: "bold", size: "lg" }]
    },
    body: { type: "box", layout: "vertical", contents: body },
    styles: { footer: { separator: true } }
  };
  if (link) {
    bubble.footer = {
      type: "box",
      layout: "vertical",
      contents: [{ type: "button", style: "primary", color: GRAPE, height: "sm", action: { type: "uri", label: k.button, uri: link } }]
    };
  }
  return { type: "flex", altText: `${k.title} · ${shop.name} · ${when.day} ${when.time}`.slice(0, 400), contents: bubble };
}

/** The customer's own booking page, opened inside LINE when the LIFF app is set up */
async function manageLink(db, { slug, token, origin }, { env = process.env } = {}) {
  if (!token) return null;
  const liffId = await getSetting(db, "line.liff_id", { env });
  if (liffId) return `https://liff.line.me/${liffId}/${slug}/manage/${token}`;
  return origin ? `${origin}/b/${slug}/manage/${token}` : null;
}

async function pushLine(db, to, messages, { fetchImpl = fetch, env = process.env } = {}) {
  if (typeof to !== "string" || !/^U[0-9a-f]{32}$/.test(to)) return { sent: false, reason: "NO_LINE_USER" };
  const token = await getSetting(db, "line.messaging_access_token", { env });
  if (!token) return { sent: false, reason: "NO_TOKEN" };
  try {
    const response = await fetchImpl("https://api.line.me/v2/bot/message/push", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "x-line-retry-key": crypto.randomUUID() },
      body: JSON.stringify({ to, messages }),
      signal: AbortSignal.timeout(5000)
    });
    if (response.ok) return { sent: true, status: response.status };
    // 400 = the customer has not added the OA as a friend (or blocked it), 429 = the month's quota
    console.error(`[line-notify] push refused: ${response.status}`);
    return { sent: false, status: response.status, reason: "LINE_REFUSED" };
  } catch (error) {
    console.error("[line-notify] push failed:", error.name || error.message);
    return { sent: false, reason: "LINE_UNAVAILABLE" };
  }
}

module.exports = { bookingCard, manageLink, pushLine };
