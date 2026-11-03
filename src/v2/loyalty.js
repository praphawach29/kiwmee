// Points for LINE members (migration …002800, docs/LOYALTY_DESIGN.md step 6e). The database does the
// counting (loyalty_balance, the earn/release/reverse triggers); this module shapes it for the shop's
// dashboard (signed-in member, row level security) and for the member's own LINE page (the server's
// connection, after LINE confirmed who they are).

const { AppError, notFound } = require("../errors");
const { themeOf } = require("./tier-themes");
const { pushLine, shopLink } = require("./line-notify");
const { publicOrigin } = require("./scan-codes");

const invalid = (message) => new AppError("INVALID", message, 422);
const LINE_USER = /^U[0-9a-f]{32}$/;
const CODE = /^[0-9]{6}$/;

const RPC_TEXT = {
  NOT_ENOUGH_POINTS: "คะแนนไม่พอสำหรับรางวัลนี้",
  REWARD_UNAVAILABLE: "รางวัลนี้ใช้ไม่ได้แล้ว",
  NOT_A_MEMBER: "บิลนี้ยังไม่ได้ผูกสมาชิก",
  MEMBER_CODE_INVALID: "รหัสสมาชิกไม่ถูกต้องหรือหมดอายุ ให้ลูกค้ากดขอรหัสใหม่",
  INVALID_POINTS: "จำนวนคะแนนไม่ถูกต้อง",
  NOT_CHANGEABLE: "บิลนี้ปิดหรือยกเลิกแล้ว",
  TIER_TOO_LOW: "รางวัลนี้สำหรับสมาชิกระดับสูงกว่านี้",
  INVALID_TIERS: "ข้อมูลระดับสมาชิกไม่ถูกต้อง",
  ALREADY_HELD: "การจองนี้ใช้คะแนนไปแล้ว"
};

/**
 * What a booking set aside when it was made (migration …003200): { rewardId, name, points, discountBaht }
 * or null. Works on the shop's connection (row level security) and the server's.
 */
async function heldReward(db, bookingId) {
  const { rows: [h] } = await db.query(
    `select h.reward_id, h.points, r.name, r.discount_baht,
            coalesce((b.price_snapshot->>'total')::numeric, 0) as total
       from (select (array_agg(l.reward_id order by l.created_at desc) filter (where l.kind = 'hold'))[1] as reward_id,
                    coalesce(-sum(l.points), 0)::int as points
               from public.loyalty_ledger l
              where l.booking_id = $1 and l.bill_id is null and l.kind in ('hold', 'release')) h
       join public.bookings b on b.id = $1
       left join public.loyalty_rewards r on r.id = h.reward_id
      where h.points > 0`,
    [bookingId]
  );
  return h ? { rewardId: h.reward_id, name: h.name, points: h.points, discountBaht: Math.min(Number(h.discount_baht), Number(h.total)) } : null;
}

// ---------- membership tiers (migration …003000) ----------
const THEMES = ["classic", "silver", "gold", "platinum", "black"];
const THEME_LABEL = { classic: "คลาสสิก", silver: "เงิน", gold: "ทอง", platinum: "แพลทินัม", black: "แบล็ก" };

const tierRow = (t) => ({
  rank: t.rank,
  name: t.name,
  minSpend: Number(t.min_spend),
  minVisits: t.min_visits,
  earnMultiplier: Number(t.earn_multiplier),
  cardTheme: t.card_theme,
  benefits: t.benefits ?? []
});

async function tiersOf(db, brandId) {
  const { rows } = await db.query("select * from public.loyalty_tiers where brand_id = $1 order by rank", [brandId]);
  return rows.map(tierRow);
}

/** { rank, name, spend, visits } — rank null when the brand has no tiers. excludeBill: the tier before that bill */
async function tierOf(db, brandId, lineUserId, excludeBill = null) {
  const { rows: [t] } = await db.query("select rank, name, spend, visits from public.loyalty_tier($1, $2, now(), $3)", [brandId, lineUserId, excludeBill]);
  return { rank: t?.rank ?? null, name: t?.name ?? null, spend: Number(t?.spend ?? 0), visits: t?.visits ?? 0 };
}

const baht = (n) => `${Math.ceil(n).toLocaleString("th-TH")} บาท`;

/**
 * Where the member stands: their tier, the next one and how far (0–1) along, in words:
 * "อีก 2,300 บาท หรือ 3 ครั้ง ถึง Gold". null when the brand has no tiers.
 */
function tierStanding(tiers, t) {
  if (!tiers.length || t.rank === null) return null;
  const current = tiers.find((x) => x.rank === t.rank) ?? tiers[0];
  const next = tiers.find((x) => x.rank === current.rank + 1) ?? null;
  let progress = 1;
  let toNext = null;
  if (next) {
    const ways = [];
    const parts = [];
    if (next.minSpend > 0) {
      ways.push(Math.min(t.spend / next.minSpend, 1));
      parts.push(baht(Math.max(next.minSpend - t.spend, 0)));
    }
    if (next.minVisits > 0) {
      ways.push(Math.min(t.visits / next.minVisits, 1));
      parts.push(`${Math.max(next.minVisits - t.visits, 0)} ครั้ง`);
    }
    progress = ways.length ? Math.max(...ways) : 0;
    toNext = `อีก ${parts.join(" หรือ ")} ถึง ${next.name}`;
  }
  return {
    rank: current.rank,
    name: current.name,
    cardTheme: current.cardTheme,
    earnMultiplier: current.earnMultiplier,
    benefits: current.benefits,
    spend: t.spend,
    visits: t.visits,
    next: next ? { name: next.name, progress: Math.round(progress * 100) / 100, text: toNext } : null
  };
}

function rpcError(error) {
  if (error.code === "42501") return new AppError("FORBIDDEN", "เฉพาะเจ้าของแบรนด์ตั้งค่าคะแนนได้", 403);
  if (["BK422", "BK404"].includes(error.code)) {
    return new AppError(error.message, RPC_TEXT[error.message] ?? error.message, error.code === "BK404" ? 404 : 422, { reason: error.message });
  }
  return error;
}

async function rpc(client, sql, params) {
  try {
    return (await client.query(sql, params)).rows[0];
  } catch (error) {
    throw rpcError(error);
  }
}

async function brandOf(db, businessId) {
  const { rows: [b] } = await db.query("select brand_id from public.businesses where id = $1", [businessId]);
  return b?.brand_id ?? null;
}

const programView = (p) =>
  p
    ? {
        active: p.active,
        name: p.name,
        earnMode: p.earn_mode,
        earnPerBaht: p.earn_per_baht === null ? null : Number(p.earn_per_baht),
        earnPoints: p.earn_points,
        expireMonths: p.expire_months
      }
    : { active: false, name: "คะแนนสะสม", earnMode: "per_baht", earnPerBaht: 100, earnPoints: 10, expireMonths: 12 };

/** "ทุก 100 บาท ได้ 10 คะแนน" */
function earnText(p) {
  if (!p) return "";
  return p.earnMode === "per_visit" ? `มาใช้บริการ 1 ครั้ง ได้ ${p.earnPoints} คะแนน` : `ทุก ${Number(p.earnPerBaht).toLocaleString("th-TH")} บาท ได้ ${p.earnPoints} คะแนน`;
}

const rewardView = (r) => ({ id: r.id, name: r.name, pointsCost: r.points_cost, discountBaht: Number(r.discount_baht), active: r.active, sortOrder: r.sort_order, minTierRank: r.min_tier_rank ?? 0 });

/** usable = enough points and the member's tier is high enough; tierName = the tier it needs, if any */
function rewardFor(r, balance, standing, tiers) {
  const tierOk = !r.minTierRank || (standing?.rank ?? 0) >= r.minTierRank;
  return { ...r, usable: balance >= r.pointsCost && tierOk, tierName: r.minTierRank ? tiers.find((t) => t.rank === r.minTierRank)?.name ?? null : null, tierOk };
}

async function balanceOf(db, brandId, lineUserId) {
  const { rows: [b] } = await db.query("select balance, expiring, expiring_at from public.loyalty_balance($1, $2)", [brandId, lineUserId]);
  return { balance: b?.balance ?? 0, expiring: b?.expiring ?? 0, expiringAt: b?.expiring_at ?? null };
}

// ---------- the shop's dashboard ----------

/** The rules, the rewards and the members with points, for the shop's brand */
async function getLoyalty(client, shop) {
  const brandId = await brandOf(client, shop.id);
  // one connection: one query at a time
  const { rows: [program] } = await client.query("select * from public.loyalty_programs where brand_id = $1", [brandId]);
  const { rows: rewards } = await client.query("select * from public.loyalty_rewards where brand_id = $1 order by active desc, sort_order, points_cost", [brandId]);
  const { rows: owner } = await client.query("select public.is_brand_owner($1) as owner", [brandId]);
  const { rows: people } = await client.query(
    `select l.line_user_id, max(l.created_at) as last_at,
            (select c.name from public.customers c where c.business_id = $2 and c.line_user_id = l.line_user_id) as name
       from public.loyalty_ledger l where l.brand_id = $1
      group by l.line_user_id order by max(l.created_at) desc limit 50`,
    [brandId, shop.id]
  );
  const tiers = await tiersOf(client, brandId);
  const members = [];
  for (const p of people) {
    const tier = tiers.length ? (await tierOf(client, brandId, p.line_user_id)).name : null;
    members.push({ lineUserId: p.line_user_id, name: p.name ?? "สมาชิก LINE", lastAt: p.last_at, tier, ...(await balanceOf(client, brandId, p.line_user_id)) });
  }
  return {
    program: { ...programView(program), qualifyMonths: program?.qualify_months ?? 12 },
    canEdit: owner[0]?.owner === true,
    rewards: rewards.map(rewardView),
    tiers,
    themes: THEMES.map((id) => ({ id, label: THEME_LABEL[id] })),
    members
  };
}

function intIn(value, label, min, max) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw invalid(`${label}ต้องเป็นจำนวนเต็ม ${min.toLocaleString("th-TH")}–${max.toLocaleString("th-TH")}`);
  return n;
}

async function saveProgram(client, shop, input = {}) {
  const brandId = await brandOf(client, shop.id);
  const mode = input.earnMode === "per_visit" ? "per_visit" : "per_baht";
  const perBaht = mode === "per_baht" ? Number(input.earnPerBaht) : null;
  if (mode === "per_baht" && !(perBaht > 0 && perBaht <= 1000000)) throw invalid("ใส่ยอดเงินต่อคะแนน (มากกว่า 0)");
  const points = intIn(input.earnPoints, "คะแนนที่ได้", 1, 100000);
  const months = input.expireMonths === null || input.expireMonths === "" || input.expireMonths === undefined ? null : intIn(input.expireMonths, "อายุคะแนน (เดือน)", 1, 120);
  const name = typeof input.name === "string" ? input.name.trim().slice(0, 60) : "";
  await rpc(client, "select public.loyalty_save_program($1, $2, $3, $4, $5, $6, $7)", [brandId, input.active === true, name, mode, perBaht, points, months]);
  return getLoyalty(client, shop);
}

/** Create (id null) or change a reward; a reward is switched off, never deleted (the history keeps it) */
async function saveReward(client, shop, id, input = {}) {
  const brandId = await brandOf(client, shop.id);
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!name || name.length > 80) throw invalid("ใส่ชื่อรางวัล (ไม่เกิน 80 ตัวอักษร)");
  const cost = intIn(input.pointsCost, "คะแนนที่ใช้", 1, 10000000);
  const discount = Number(input.discountBaht);
  if (!(discount > 0 && discount <= 1000000)) throw invalid("ส่วนลดต้องมากกว่า 0 บาท");
  const minTier = input.minTierRank === undefined || input.minTierRank === null || input.minTierRank === "" ? 0 : intIn(input.minTierRank, "ระดับขั้นต่ำ", 0, 4);
  const values = [name, cost, Math.round(discount * 100) / 100, input.active !== false, Number.isInteger(input.sortOrder) ? input.sortOrder : 0, minTier];
  try {
    if (id) {
      const { rowCount } = await client.query(
        "update public.loyalty_rewards set name = $3, points_cost = $4, discount_baht = $5, active = $6, sort_order = $7, min_tier_rank = $8 where id = $1 and brand_id = $2",
        [id, brandId, ...values]
      );
      if (!rowCount) throw notFound("ไม่พบรางวัลนี้");
    } else {
      await client.query("insert into public.loyalty_rewards (brand_id, name, points_cost, discount_baht, active, sort_order, min_tier_rank) values ($1, $2, $3, $4, $5, $6, $7)", [brandId, ...values]);
    }
  } catch (error) {
    if (error.code === "42501") throw new AppError("FORBIDDEN", "เฉพาะเจ้าของแบรนด์ตั้งรางวัลได้", 403);
    throw error;
  }
  return getLoyalty(client, shop);
}

/** The owner gives (+) or takes (−) points by hand */
async function adjustPoints(client, shop, input = {}) {
  if (typeof input.lineUserId !== "string" || !LINE_USER.test(input.lineUserId)) throw invalid("ไม่พบสมาชิก");
  const points = intIn(input.points, "คะแนน", -1000000, 1000000);
  if (points === 0) throw invalid("ใส่คะแนนที่ไม่ใช่ 0");
  await rpc(client, "select public.loyalty_adjust($1, $2, $3, $4)", [shop.id, input.lineUserId, points, typeof input.note === "string" ? input.note.slice(0, 200) : null]);
  return getLoyalty(client, shop);
}

/**
 * The brand owner saves the tiers together: { qualifyMonths, tiers: [{ name, minSpend, minVisits,
 * earnMultiplier, cardTheme, benefits: [text] }] } in order from the starting tier up (at most 5).
 */
async function saveTiers(client, shop, input = {}) {
  const brandId = await brandOf(client, shop.id);
  const months = intIn(input.qualifyMonths ?? 12, "ช่วงเวลาที่นับยอด (เดือน)", 1, 36);
  const list = Array.isArray(input.tiers) ? input.tiers : null;
  if (!list || list.length > 5) throw invalid("ตั้งได้ไม่เกิน 5 ระดับ");
  const names = new Set();
  let last = { spend: 0, visits: 0 };
  const tiers = list.map((t, rank) => {
    const name = typeof t?.name === "string" ? t.name.trim() : "";
    if (!name || name.length > 30) throw invalid(`ใส่ชื่อระดับที่ ${rank + 1} (ไม่เกิน 30 ตัวอักษร)`);
    if (names.has(name)) throw invalid(`ชื่อระดับ "${name}" ซ้ำ`);
    names.add(name);
    const minSpend = rank === 0 ? 0 : Number(t.minSpend || 0);
    const minVisits = rank === 0 ? 0 : intIn(t.minVisits || 0, `จำนวนครั้งของ ${name}`, 0, 10000);
    if (!(minSpend >= 0 && minSpend <= 100000000)) throw invalid(`ยอดใช้จ่ายของ ${name} ไม่ถูกต้อง`);
    if (rank > 0 && minSpend === 0 && minVisits === 0) throw invalid(`ใส่ยอดใช้จ่ายหรือจำนวนครั้งที่ต้องถึงสำหรับ ${name}`);
    if (rank > 1 && minSpend > 0 && last.spend > 0 && minSpend <= last.spend) throw invalid(`ยอดใช้จ่ายของ ${name} ต้องมากกว่าระดับก่อนหน้า`);
    if (rank > 1 && minVisits > 0 && last.visits > 0 && minVisits <= last.visits) throw invalid(`จำนวนครั้งของ ${name} ต้องมากกว่าระดับก่อนหน้า`);
    if (rank > 0) last = { spend: minSpend, visits: minVisits };
    const multiplier = Number(t.earnMultiplier ?? 1);
    if (!(multiplier >= 1 && multiplier <= 5)) throw invalid(`ตัวคูณคะแนนของ ${name} ต้องอยู่ระหว่าง 1–5`);
    const theme = THEMES.includes(t.cardTheme) ? t.cardTheme : "classic";
    const benefits = (Array.isArray(t.benefits) ? t.benefits : []).map((b) => String(b).trim().slice(0, 80)).filter(Boolean);
    if (benefits.length > 5) throw invalid(`สิทธิพิเศษของ ${name} ใส่ได้ไม่เกิน 5 ข้อ`);
    return { name, min_spend: Math.round(minSpend * 100) / 100, min_visits: minVisits, earn_multiplier: Math.round(multiplier * 100) / 100, card_theme: theme, benefits };
  });
  await rpc(client, "select public.loyalty_save_tiers($1, $2, $3::jsonb)", [brandId, months, JSON.stringify(tiers)]);
  return getLoyalty(client, shop);
}

/**
 * At the counter: who is this member and what can they use? { code } (walk-in, the code is NOT used up
 * here) or { bookingId } (a booking made inside LINE). Returns null when there is no member.
 */
async function memberAtCounter(client, shop, { code, bookingId } = {}) {
  let lineUserId = null;
  if (code) {
    if (!CODE.test(String(code).trim())) throw invalid("รหัสสมาชิกเป็นตัวเลข 6 หลัก");
    lineUserId = (await rpc(client, "select public.loyalty_peek_code($1, $2) as member", [shop.id, String(code).trim()])).member;
    if (!lineUserId) throw new AppError("MEMBER_CODE_INVALID", RPC_TEXT.MEMBER_CODE_INVALID, 422);
  } else if (bookingId) {
    const { rows: [b] } = await client.query(
      "select c.line_user_id from public.bookings b join public.customers c on c.id = b.customer_id where b.id = $1 and b.business_id = $2",
      [bookingId, shop.id]
    );
    lineUserId = b?.line_user_id ?? null;
  }
  if (!lineUserId) return null;
  const brandId = await brandOf(client, shop.id);
  const { rows: [program] } = await client.query("select * from public.loyalty_programs where brand_id = $1 and active", [brandId]);
  const { rows: rewards } = await client.query("select * from public.loyalty_rewards where brand_id = $1 and active order by sort_order, points_cost", [brandId]);
  const { rows: [person] } = await client.query("select name from public.customers where business_id = $1 and line_user_id = $2", [shop.id, lineUserId]);
  if (!program) return null;
  const balance = await balanceOf(client, brandId, lineUserId);
  const tiers = await tiersOf(client, brandId);
  const standing = tiers.length ? tierStanding(tiers, await tierOf(client, brandId, lineUserId)) : null;
  // points the customer set aside when booking: theirs to use on this bill
  const held = bookingId ? await heldReward(client, bookingId) : null;
  return {
    name: person?.name ?? "สมาชิก LINE",
    ...balance,
    held,
    tier: standing ? { name: standing.name, cardTheme: standing.cardTheme, earnMultiplier: standing.earnMultiplier } : null,
    rewards: rewards.map(rewardView).map((r) => rewardFor(r, balance.balance + (held?.points ?? 0), standing, tiers))
  };
}

/** Before a bill closes: tie it to the member (a code) and put a reward on it */
async function applyAtCounter(client, billId, { memberCode, rewardId } = {}) {
  if (memberCode) await rpc(client, "select public.bill_attach_member($1, $2)", [billId, String(memberCode).trim()]);
  if (rewardId) await rpc(client, "select public.bill_use_reward($1, $2)", [billId, rewardId]);
}

// ---------- the member's own LINE page ----------

/** The member's card at this shop's brand: balance, what runs out soon, rewards, the latest entries */
async function memberCard(db, shop, lineUserId) {
  const brandId = shop.brand_id ?? (await brandOf(db, shop.id));
  const { rows: [program] } = await db.query("select * from public.loyalty_programs where brand_id = $1 and active", [brandId]);
  if (!program) return null;
  const { rows: rewards } = await db.query("select * from public.loyalty_rewards where brand_id = $1 and active order by sort_order, points_cost", [brandId]);
  const { rows: history } = await db.query(
    `select l.kind, l.points, l.created_at, b.name as shop from public.loyalty_ledger l left join public.businesses b on b.id = l.business_id
      where l.brand_id = $1 and l.line_user_id = $2 order by l.created_at desc limit 10`,
    [brandId, lineUserId]
  );
  const view = programView(program);
  const balance = await balanceOf(db, brandId, lineUserId);
  const tiers = await tiersOf(db, brandId);
  const standing = tiers.length ? tierStanding(tiers, await tierOf(db, brandId, lineUserId)) : null;
  return {
    name: view.name,
    rule: earnText(view),
    expireMonths: view.expireMonths,
    ...balance,
    // the membership tier (migration …003000): name, card look, bonus, perks, the way to the next one
    tier: standing ? { ...standing, qualifyMonths: program.qualify_months ?? 12 } : null,
    rewards: rewards.map(rewardView).map((r) => rewardFor(r, balance.balance, standing, tiers)).map((r) => ({ id: r.id, name: r.name, pointsCost: r.pointsCost, discountBaht: r.discountBaht, usable: r.usable, tierName: r.tierOk ? null : r.tierName })),
    history: history.map((h) => ({ kind: h.kind, points: h.points, at: h.created_at, shop: h.shop }))
  };
}

/** A 6-digit code the member shows at the counter, good for 10 minutes */
async function issueMemberCode(db, shop, lineUserId) {
  const brandId = shop.brand_id ?? (await brandOf(db, shop.id));
  const { rows: [program] } = await db.query("select 1 from public.loyalty_programs where brand_id = $1 and active", [brandId]);
  if (!program) throw new AppError("NOT_AVAILABLE", "ร้านนี้ยังไม่เปิดระบบสะสมคะแนน", 404);
  const { rows: [r] } = await db.query("select public.loyalty_issue_code($1, $2) as code", [brandId, lineUserId]);
  return { code: r.code, expiresInSeconds: 600 };
}

// ---------- "you moved up a tier" (LINE) ----------

/** The Flex card: the new tier on its card colours, its perks, and a button to the member's page */
function tierUpCard({ shopName, programName, standing, link }) {
  const theme = themeOf(standing.cardTheme);
  const perks = [
    ...(standing.earnMultiplier > 1 ? [`ได้คะแนน ×${standing.earnMultiplier}`] : []),
    ...standing.benefits
  ];
  return {
    type: "flex",
    altText: `ยินดีด้วย! คุณเป็นสมาชิกระดับ ${standing.name} ของ ${shopName} แล้ว`.slice(0, 400),
    contents: {
      type: "bubble",
      size: "mega",
      body: {
        type: "box",
        layout: "vertical",
        paddingAll: "xl",
        background: { type: "linearGradient", angle: "135deg", startColor: theme.from, endColor: theme.to },
        contents: [
          { type: "text", text: `🎉 ขึ้นระดับแล้ว · ${shopName}`, size: "sm", color: theme.text, wrap: true },
          { type: "text", text: standing.name, size: "3xl", weight: "bold", color: theme.text, margin: "md", wrap: true },
          { type: "text", text: programName, size: "sm", color: theme.text, margin: "xs", wrap: true },
          ...(perks.length
            ? [{ type: "box", layout: "vertical", margin: "lg", spacing: "xs", contents: perks.map((p) => ({ type: "text", text: `✦ ${p}`, size: "sm", color: theme.text, wrap: true })) }]
            : []),
          ...(standing.next ? [{ type: "text", text: standing.next.text, size: "xs", color: theme.text, margin: "lg", wrap: true }] : [])
        ]
      },
      ...(link
        ? { footer: { type: "box", layout: "vertical", paddingAll: "md", contents: [{ type: "button", style: "primary", color: "#6A4CFF", height: "sm", action: { type: "uri", label: "ดูบัตรสมาชิก", uri: link } }] } }
        : {})
    }
  };
}

/**
 * After a bill is paid (the transaction committed): did it lift the member to a higher tier? Then
 * send them the card in LINE. db = the server's pool. Never throws: { sent } | { skipped: reason }.
 */
async function notifyTierUp(db, billId, { push = (to, messages) => pushLine(db, to, messages), env = process.env } = {}) {
  try {
    const { rows: [b] } = await db.query(
      `select bl.line_user_id, bl.status, s.brand_id, s.name as shop_name, s.slug, p.name as program_name, p.active
         from public.bills bl join public.businesses s on s.id = bl.business_id
         left join public.loyalty_programs p on p.brand_id = s.brand_id
        where bl.id = $1`,
      [billId]
    );
    if (!b?.line_user_id || b.status !== "closed" || !b.active) return { skipped: "NOT_A_MEMBER_BILL" };
    const tiers = await tiersOf(db, b.brand_id);
    if (tiers.length < 2) return { skipped: "NO_TIERS" };
    const before = await tierOf(db, b.brand_id, b.line_user_id, billId);
    const after = await tierOf(db, b.brand_id, b.line_user_id);
    if ((after.rank ?? 0) <= (before.rank ?? 0)) return { skipped: "SAME_TIER" };
    const shop = await shopLink(db, { slug: b.slug, origin: publicOrigin(env) }, { env });
    const card = tierUpCard({ shopName: b.shop_name, programName: b.program_name, standing: tierStanding(tiers, after), link: shop ? `${shop}/me` : null });
    return await push(b.line_user_id, [card]);
  } catch (error) {
    console.error("[loyalty] tier card not sent:", error.message);
    return { skipped: "ERROR" };
  }
}

module.exports = {
  getLoyalty,
  saveProgram,
  saveReward,
  saveTiers,
  adjustPoints,
  memberAtCounter,
  applyAtCounter,
  memberCard,
  heldReward,
  issueMemberCode,
  earnText,
  tierStanding,
  tierUpCard,
  notifyTierUp,
  RPC_TEXT
};
