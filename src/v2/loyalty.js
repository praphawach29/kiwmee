// Points for LINE members (migration …002800, docs/LOYALTY_DESIGN.md step 6e). The database does the
// counting (loyalty_balance, the earn/release/reverse triggers); this module shapes it for the shop's
// dashboard (signed-in member, row level security) and for the member's own LINE page (the server's
// connection, after LINE confirmed who they are).

const { AppError, notFound } = require("../errors");

const invalid = (message) => new AppError("INVALID", message, 422);
const LINE_USER = /^U[0-9a-f]{32}$/;
const CODE = /^[0-9]{6}$/;

const RPC_TEXT = {
  NOT_ENOUGH_POINTS: "คะแนนไม่พอสำหรับรางวัลนี้",
  REWARD_UNAVAILABLE: "รางวัลนี้ใช้ไม่ได้แล้ว",
  NOT_A_MEMBER: "บิลนี้ยังไม่ได้ผูกสมาชิก",
  MEMBER_CODE_INVALID: "รหัสสมาชิกไม่ถูกต้องหรือหมดอายุ ให้ลูกค้ากดขอรหัสใหม่",
  INVALID_POINTS: "จำนวนคะแนนไม่ถูกต้อง",
  NOT_CHANGEABLE: "บิลนี้ปิดหรือยกเลิกแล้ว"
};

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

const rewardView = (r) => ({ id: r.id, name: r.name, pointsCost: r.points_cost, discountBaht: Number(r.discount_baht), active: r.active, sortOrder: r.sort_order });

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
  const members = [];
  for (const p of people) members.push({ lineUserId: p.line_user_id, name: p.name ?? "สมาชิก LINE", lastAt: p.last_at, ...(await balanceOf(client, brandId, p.line_user_id)) });
  return { program: programView(program), canEdit: owner[0]?.owner === true, rewards: rewards.map(rewardView), members };
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
  const values = [name, cost, Math.round(discount * 100) / 100, input.active !== false, Number.isInteger(input.sortOrder) ? input.sortOrder : 0];
  try {
    if (id) {
      const { rowCount } = await client.query(
        "update public.loyalty_rewards set name = $3, points_cost = $4, discount_baht = $5, active = $6, sort_order = $7 where id = $1 and brand_id = $2",
        [id, brandId, ...values]
      );
      if (!rowCount) throw notFound("ไม่พบรางวัลนี้");
    } else {
      await client.query("insert into public.loyalty_rewards (brand_id, name, points_cost, discount_baht, active, sort_order) values ($1, $2, $3, $4, $5, $6)", [brandId, ...values]);
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
  return {
    name: person?.name ?? "สมาชิก LINE",
    ...balance,
    rewards: rewards.map(rewardView).map((r) => ({ ...r, usable: balance.balance >= r.pointsCost }))
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
  return {
    name: view.name,
    rule: earnText(view),
    expireMonths: view.expireMonths,
    ...balance,
    rewards: rewards.map(rewardView).map((r) => ({ name: r.name, pointsCost: r.pointsCost, discountBaht: r.discountBaht, usable: balance.balance >= r.pointsCost })),
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

module.exports = { getLoyalty, saveProgram, saveReward, adjustPoints, memberAtCounter, applyAtCounter, memberCard, issueMemberCode, earnText, RPC_TEXT };
