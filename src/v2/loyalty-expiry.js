// "Your points run out soon" (docs/LOYALTY_DESIGN.md §4): 14 days before a member's points expire,
// a LINE card says how many, on which day, what they can still get for them, and opens their card.
// Runs with the booking reminders (src/v2/line-reminders.js), on the server's own connection.
// One card per member, brand and expiry day (loyalty_expiry_notices, migration …003100), claimed
// before it is sent. Cards go out in the daytime only (10:00–20:00 Bangkok).

const { pushLine, shopLink } = require("./line-notify");
const { publicOrigin } = require("./scan-codes");
const { themeOf } = require("./tier-themes");

const WARN_DAYS = 14;
const ZONE = "Asia/Bangkok";

const hourIn = (now) => Number(new Intl.DateTimeFormat("en-GB", { timeZone: ZONE, hour: "2-digit", hourCycle: "h23" }).format(now));
const dayOf = (iso) => new Intl.DateTimeFormat("en-CA", { timeZone: ZONE, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));
const thaiDate = (iso) => new Intl.DateTimeFormat("th-TH", { timeZone: ZONE, day: "numeric", month: "short", year: "numeric" }).format(new Date(iso));

/** Members with points expiring within 14 days whose day has not been told yet, soonest first */
async function dueNotices(db, now, limit) {
  const { rows } = await db.query(
    `select l.brand_id, l.line_user_id, min(l.expires_at) as expires_at
       from public.loyalty_ledger l
       join public.loyalty_programs p on p.brand_id = l.brand_id and p.active
      where l.points > 0 and l.expires_at > $1 and l.expires_at <= $1 + make_interval(days => $3)
        and not exists (select 1 from public.loyalty_expiry_notices n
                         where n.brand_id = l.brand_id and n.line_user_id = l.line_user_id
                           and n.expires_on = (l.expires_at at time zone '${ZONE}')::date)
      group by l.brand_id, l.line_user_id
      order by min(l.expires_at)
      limit $2`,
    [now.toISOString(), limit, WARN_DAYS]
  );
  return rows;
}

/** How many points are gone by that moment: today's balance less the balance just after it */
async function expiringBy(db, brandId, lineUserId, now, at) {
  const balance = async (when) => (await db.query("select balance from public.loyalty_balance($1, $2, $3)", [brandId, lineUserId, when])).rows[0]?.balance ?? 0;
  const today = await balance(now.toISOString());
  const after = await balance(new Date(new Date(at).getTime() + 1000).toISOString());
  return { balance: today, points: Math.max(today - after, 0) };
}

/**
 * The card: points and day in big type, the balance, up to two rewards they can get now, and buttons
 * to their member card and to book again.
 */
function expiryCard({ shopName, programName, points, expiresAt, balance, rewards = [], tier = null, cardLink = null, bookLink = null, logoUrl = null }) {
  const theme = themeOf(tier?.cardTheme);
  const date = thaiDate(expiresAt);
  const body = [
    ...(logoUrl?.startsWith("https://") ? [{ type: "image", url: logoUrl, size: "xxs", aspectRatio: "1:1", aspectMode: "cover", align: "start" }] : []),
    { type: "text", text: programName, size: "sm", color: "#5F5A7A", wrap: true },
    {
      type: "box",
      layout: "vertical",
      margin: "md",
      paddingAll: "md",
      cornerRadius: "md",
      background: { type: "linearGradient", angle: "135deg", startColor: theme.from, endColor: theme.to },
      contents: [
        { type: "text", text: `${points.toLocaleString("th-TH")} คะแนน`, size: "xxl", weight: "bold", color: theme.text },
        { type: "text", text: `จะหมดอายุ ${date}`, size: "sm", color: theme.text, margin: "xs", wrap: true },
        ...(tier?.name ? [{ type: "text", text: `สมาชิก ${tier.name}`, size: "xs", color: theme.text, margin: "sm" }] : [])
      ]
    },
    {
      type: "box",
      layout: "baseline",
      margin: "lg",
      contents: [
        { type: "text", text: "คงเหลือทั้งหมด", size: "sm", color: "#5F5A7A", flex: 5 },
        { type: "text", text: `${balance.toLocaleString("th-TH")} คะแนน`, size: "sm", weight: "bold", color: "#1B1640", align: "end", flex: 5 }
      ]
    }
  ];
  if (rewards.length) {
    body.push({ type: "separator", margin: "lg", color: "#E8E4F8" });
    body.push({ type: "text", text: "แลกได้ตอนนี้", size: "sm", weight: "bold", color: "#1B1640", margin: "lg" });
    for (const r of rewards.slice(0, 2)) {
      body.push({
        type: "box",
        layout: "baseline",
        margin: "sm",
        contents: [
          { type: "text", text: `🎁 ${r.name}`, size: "sm", color: "#1B1640", flex: 7, wrap: true },
          { type: "text", text: `${r.pointsCost.toLocaleString("th-TH")} คะแนน`, size: "xs", color: "#5F5A7A", align: "end", flex: 3 }
        ]
      });
    }
    body.push({ type: "text", text: "บอกพนักงานตอนจ่ายเงิน ก่อนคะแนนหมดอายุ", size: "xs", color: "#5F5A7A", margin: "sm", wrap: true });
  }
  const buttons = [
    ...(cardLink ? [{ type: "button", style: "primary", color: "#6A4CFF", height: "sm", action: { type: "uri", label: "ดูบัตรสมาชิก", uri: cardLink } }] : []),
    ...(bookLink ? [{ type: "button", style: "secondary", height: "sm", action: { type: "uri", label: rewards.length ? "จองคิวใช้คะแนน" : "จองคิวอีกครั้ง", uri: bookLink } }] : [])
  ];
  return {
    type: "flex",
    altText: `${points.toLocaleString("th-TH")} คะแนนที่ ${shopName} จะหมดอายุ ${date}`.slice(0, 400),
    contents: {
      type: "bubble",
      size: "mega",
      header: {
        type: "box",
        layout: "vertical",
        paddingAll: "lg",
        backgroundColor: "#B54708",
        contents: [
          { type: "text", text: "⏳ คะแนนใกล้หมดอายุ", color: "#FFFFFF", weight: "bold", size: "md" },
          { type: "text", text: shopName, color: "#FFFFFFCC", size: "sm", wrap: true, margin: "xs" }
        ]
      },
      body: { type: "box", layout: "vertical", paddingAll: "lg", contents: body },
      ...(buttons.length ? { footer: { type: "box", layout: "vertical", spacing: "sm", paddingAll: "md", contents: buttons } } : {})
    }
  };
}

/**
 * Sends what is due now. Returns { checked, sent, skipped }. Outside 10:00–20:00 Bangkok: nothing.
 * push(to, messages) is injectable for tests; db is the server's pool (the database owner).
 */
async function sendExpiryNotices(db, { now = new Date(), push = (to, messages) => pushLine(db, to, messages), limit = 100, env = process.env } = {}) {
  const hour = hourIn(now);
  if (hour < 10 || hour >= 20) return { checked: 0, sent: 0, skipped: 0 };
  const due = await dueNotices(db, now, limit);
  let sent = 0;
  let skipped = 0;
  for (const d of due) {
    const expiresOn = dayOf(d.expires_at);
    const { balance, points } = await expiringBy(db, d.brand_id, d.line_user_id, now, d.expires_at);
    // claim the day first: whoever inserts the row sends the card
    const claim = await db.query(
      `insert into public.loyalty_expiry_notices (brand_id, line_user_id, expires_on, points) values ($1, $2, $3, $4)
       on conflict do nothing returning brand_id`,
      [d.brand_id, d.line_user_id, expiresOn, points]
    );
    if (!claim.rowCount) {
      skipped++;
      continue;
    }
    let result;
    if (points <= 0) {
      result = { sent: false, reason: "NOTHING_LEFT" }; // already used: nothing to warn about
    } else {
      try {
        result = await push(d.line_user_id, [await cardFor(db, d, points, balance, env)]);
      } catch (error) {
        console.error("[loyalty-expiry] not sent:", error.message);
        result = { sent: false, reason: "ERROR" };
      }
    }
    if (result?.sent) sent++;
    await db.query("update public.loyalty_expiry_notices set result = $4 where brand_id = $1 and line_user_id = $2 and expires_on = $3", [
      d.brand_id,
      d.line_user_id,
      expiresOn,
      result?.sent ? "sent" : String(result?.reason ?? "ERROR").slice(0, 40)
    ]);
  }
  return { checked: due.length, sent, skipped };
}

// The shop the member last earned or used points at is the one the card speaks for
async function cardFor(db, d, points, balance, env) {
  const { rows: [shop] } = await db.query(
    `select s.name, s.slug, p.name as program_name, (select logo_url from public.brands where id = p.brand_id) as logo_url
       from public.loyalty_programs p
       join public.businesses s on s.brand_id = p.brand_id
       left join lateral (select max(l.created_at) as at from public.loyalty_ledger l
                           where l.brand_id = p.brand_id and l.line_user_id = $2 and l.business_id = s.id) last on true
      where p.brand_id = $1
      order by last.at desc nulls last, s.created_at
      limit 1`,
    [d.brand_id, d.line_user_id]
  );
  const { rows: rewards } = await db.query(
    "select name, points_cost from public.loyalty_rewards where brand_id = $1 and active and points_cost <= $2 order by points_cost desc limit 2",
    [d.brand_id, balance]
  );
  const { rows: [tier] } = await db.query(
    "select t.name, (select card_theme from public.loyalty_tiers x where x.brand_id = $1 and x.rank = t.rank) as card_theme from public.loyalty_tier($1, $2) t where t.rank is not null",
    [d.brand_id, d.line_user_id]
  );
  const book = await shopLink(db, { slug: shop.slug, origin: publicOrigin(env) }, { env });
  return expiryCard({
    shopName: shop.name,
    programName: shop.program_name,
    points,
    expiresAt: d.expires_at,
    balance,
    rewards: rewards.map((r) => ({ name: r.name, pointsCost: r.points_cost })),
    tier: tier ? { name: tier.name, cardTheme: tier.card_theme } : null,
    cardLink: book ? `${book}/me` : null,
    bookLink: book,
    logoUrl: shop.logo_url
  });
}

module.exports = { sendExpiryNotices, expiryCard, WARN_DAYS };
