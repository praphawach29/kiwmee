// Booking cards sent to the customer's LINE through Kiwmee's central Official Account
// (docs/LOYALTY_DESIGN.md: one OA for every shop at first). Only customers who booked inside LINE
// (LIFF, so we know their LINE user id) get them, and LINE delivers only to people who added the OA
// as a friend. A card that cannot be sent never fails the booking: the result says why instead.
//
//   bookingCard(...)  → a Flex message (pure, unit-tested)
//   pushLine(db, to, messages)  → { sent, status?, reason? } with the token saved in /super

const crypto = require("node:crypto");
const { getSetting, encrypt, decrypt } = require("./platform-settings");

const GRAPE = "#6A4CFF";
const GRAPE_DEEP = "#4F33E0";
const INK = "#1B1640";
const MUTED = "#5F5A7A";
const MIST = "#F7F5FF";
const LINE_SOFT = "#E8E4F8";
const WARN = "#B54708";

const baht = (n) => `${Number(n).toLocaleString("th-TH")} บาท`;
const KIND_WORD = { staff: "ช่าง", court: "สนาม", room: "ห้อง", equipment: "อุปกรณ์" };
const kindWord = (kind) => KIND_WORD[kind] ?? kind ?? "ช่าง/สนาม";

// "วันอังคาร 3 พ.ย. 2569" and "14:00–15:00 น." in the shop's time zone
function whenText(startAt, endAt, timezone) {
  const part = (opts, iso = startAt) => new Intl.DateTimeFormat("th-TH", { timeZone: timezone, ...opts }).format(new Date(iso));
  const clock = (iso) => part({ hour: "2-digit", minute: "2-digit", hourCycle: "h23" }, iso);
  return {
    day: `${part({ weekday: "long" })} ${part({ day: "numeric", month: "short", year: "numeric" })}`,
    time: endAt ? `${clock(startAt)}–${clock(endAt)} น.` : `${clock(startAt)} น.`,
    clock
  };
}

const row = (label, value, { bold = false } = {}) => ({
  type: "box",
  layout: "baseline",
  spacing: "md",
  contents: [
    { type: "text", text: label, size: "sm", color: MUTED, flex: 3 },
    { type: "text", text: String(value), size: "sm", color: INK, flex: 7, wrap: true, align: "end", weight: bold ? "bold" : "regular" }
  ]
});

const KINDS = {
  booked: { title: "จองสำเร็จ", icon: "✓", color: GRAPE, button: "ดู เลื่อน หรือยกเลิกนัด" },
  held: { title: "กันคิวไว้ให้แล้ว", icon: "⏳", color: WARN, button: "แนบสลิปโอนมัดจำ" },
  confirmed: { title: "ร้านยืนยันคิวแล้ว", icon: "✓", color: "#0B7A50", button: "ดูการจองของฉัน" },
  remind_day: { title: "พรุ่งนี้มีนัด", icon: "🔔", color: GRAPE, button: "ดู เลื่อน หรือยกเลิกนัด" },
  remind_soon: { title: "ใกล้ถึงเวลานัดแล้ว", icon: "⏰", color: GRAPE_DEEP, button: "ดูการจองของฉัน" }
};

/**
 * kind: booked | held (waiting for a transfer deposit) | confirmed (the shop confirmed the deposit)
 * booking: { offering, startAt, endAt, resources: [names], resourceKind, addons: [{ name, quantity }],
 *            total, deposit: { due, holdExpiresAt } | null }
 * link: where the button goes (the customer's own booking page), or null for no button
 */
function bookingCard({ kind, shop, booking, link }) {
  const k = KINDS[kind] ?? KINDS.booked;
  const when = whenText(booking.startAt, booking.endAt, shop.timezone);

  const details = [];
  if (booking.resources?.length) details.push(row(kindWord(booking.resourceKind), booking.resources.join(", ")));
  if (booking.addons?.length) details.push(row("เพิ่มเติม", booking.addons.map((a) => `${a.name}${a.quantity > 1 ? ` ×${a.quantity}` : ""}`).join(", ")));

  const body = [
    { type: "text", text: booking.offering, weight: "bold", size: "md", color: INK, wrap: true },
    {
      // the date and time, the thing the customer looks for first
      type: "box",
      layout: "vertical",
      margin: "md",
      paddingAll: "md",
      backgroundColor: MIST,
      cornerRadius: "md",
      contents: [
        { type: "text", text: when.day, size: "sm", color: MUTED, wrap: true },
        { type: "text", text: when.time, size: "xl", weight: "bold", color: GRAPE_DEEP, margin: "xs" }
      ]
    }
  ];
  if (details.length) body.push({ type: "box", layout: "vertical", spacing: "sm", margin: "lg", contents: details });
  if (booking.total > 0) {
    body.push({ type: "separator", margin: "lg", color: LINE_SOFT });
    body.push({
      type: "box",
      layout: "baseline",
      margin: "md",
      contents: [
        { type: "text", text: "ราคา", size: "sm", color: MUTED, flex: 3 },
        { type: "text", text: baht(booking.total), size: "lg", weight: "bold", color: INK, align: "end", flex: 7 }
      ]
    });
  }
  if (kind === "held" && booking.deposit) {
    const by = booking.deposit.holdExpiresAt ? ` ภายใน ${when.clock(booking.deposit.holdExpiresAt)} น.` : "";
    body.push({
      type: "box",
      layout: "vertical",
      margin: "lg",
      paddingAll: "md",
      backgroundColor: "#FFF4E5",
      cornerRadius: "md",
      contents: [
        { type: "text", text: `โอนมัดจำ ${baht(booking.deposit.due)}${by}`, size: "sm", weight: "bold", color: WARN, wrap: true },
        { type: "text", text: "แล้วแนบสลิป ไม่อย่างนั้นคิวจะถูกปล่อยให้คนอื่น", size: "xs", color: WARN, wrap: true, margin: "xs" }
      ]
    });
  }

  const bubble = {
    type: "bubble",
    size: "mega",
    header: {
      type: "box",
      layout: "vertical",
      paddingAll: "lg",
      backgroundColor: k.color,
      contents: [
        { type: "text", text: `${k.icon} ${k.title}`, color: "#FFFFFF", weight: "bold", size: "md" },
        { type: "text", text: shop.name, color: "#FFFFFFCC", size: "sm", wrap: true, margin: "xs" }
      ]
    },
    body: { type: "box", layout: "vertical", paddingAll: "lg", contents: body },
    footer: {
      type: "box",
      layout: "vertical",
      spacing: "sm",
      paddingAll: "md",
      contents: [
        ...(link ? [{ type: "button", style: "primary", color: GRAPE, height: "sm", action: { type: "uri", label: k.button, uri: link } }] : []),
        { type: "text", text: "จองผ่าน Kiwmee", size: "xxs", color: "#AAA6C3", align: "center", margin: link ? "sm" : "none" }
      ]
    }
  };
  return { type: "flex", altText: `${k.title} · ${shop.name} · ${when.day} ${when.time}`.slice(0, 400), contents: bubble };
}

// The customer's booking link kept for later cards (reminders), encrypted with the platform key so
// the database alone cannot open anyone's booking. null when no key is set.
function sealLink(bookingId, token, env = process.env) {
  try {
    return encrypt(`booking-link:${bookingId}`, token, env);
  } catch {
    return null;
  }
}

function openLink(bookingId, sealed, env = process.env) {
  if (!sealed) return null;
  try {
    return decrypt(`booking-link:${bookingId}`, sealed, env);
  } catch {
    return null;
  }
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

module.exports = { bookingCard, manageLink, pushLine, sealLink, openLink };
