// The shop's team (docs/SALES_READINESS_ROADMAP.md Phase 0): owners see who works at the shop,
// invite people by email, change their role and remove them. Kiwmee sends no email: the person
// signs in at /dashboard with that address and the invite is taken up then (listBrands in
// admin-brands.js runs accept_my_invites).
//
// Every function takes a client running as the signed-in user; the RPCs (migration …001700)
// check that the caller owns the shop and that the shop keeps at least one owner.

const { AppError, notFound } = require("../errors");

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ROLES = ["owner", "staff"];

const REASON_TEXT = {
  INVALID_EMAIL: "อีเมลไม่ถูกต้อง",
  INVALID_ROLE: "เลือกสิทธิ์เป็นเจ้าของร้านหรือพนักงาน",
  ALREADY_MEMBER: "อีเมลนี้อยู่ในร้านนี้แล้ว",
  LAST_OWNER: "ร้านต้องมีเจ้าของอย่างน้อย 1 คน",
  NOT_FOUND: "ไม่พบสมาชิกหรือคำเชิญนี้"
};

function rpcError(error) {
  if (error?.code === "BK404") return notFound(REASON_TEXT.NOT_FOUND);
  if (error?.code === "BK422") return new AppError("UNAVAILABLE", REASON_TEXT[error.message] ?? error.message, 422, { reason: error.message });
  return error;
}

async function rpc(client, sql, params) {
  try {
    return (await client.query(sql, params)).rows[0];
  } catch (error) {
    throw rpcError(error);
  }
}

function id(value) {
  if (typeof value !== "string" || !UUID.test(value)) throw notFound(REASON_TEXT.NOT_FOUND);
  return value;
}

function role(value) {
  if (!ROLES.includes(value)) throw new AppError("INVALID", REASON_TEXT.INVALID_ROLE, 422);
  return value;
}

/** { members: [{ userId, email, role, since, brandOwner, you }], invites: [{ id, email, role, createdAt }] } */
async function getTeam(client, shop) {
  const row = await rpc(client, "select public.shop_team($1) as team, auth.uid() as me", [shop.id]);
  return {
    members: row.team.members.map((m) => ({
      userId: m.user_id,
      email: m.email,
      role: m.role,
      since: m.since,
      brandOwner: m.brand_owner,
      you: m.user_id === row.me
    })),
    invites: row.team.invites.map((i) => ({ id: i.id, email: i.email, role: i.role, createdAt: i.created_at }))
  };
}

/** { email, role } → { status: "added" | "invited", email, role } */
async function inviteMember(client, shop, input = {}) {
  const email = typeof input.email === "string" ? input.email.trim().toLowerCase() : "";
  if (!email || email.length > 254) throw new AppError("INVALID", REASON_TEXT.INVALID_EMAIL, 422);
  const row = await rpc(client, "select public.invite_member($1, $2, $3) as result", [shop.id, email, role(input.role ?? "staff")]);
  return row.result;
}

async function setMemberRole(client, shop, userId, input = {}) {
  await rpc(client, "select public.set_member_role($1, $2, $3)", [shop.id, id(userId), role(input.role)]);
  return { userId, role: input.role };
}

async function removeMember(client, shop, userId) {
  await rpc(client, "select public.remove_member($1, $2)", [shop.id, id(userId)]);
  return { userId };
}

async function cancelInvite(client, shop, inviteId) {
  await rpc(client, "select public.cancel_invite($1, $2)", [shop.id, id(inviteId)]);
  return { id: inviteId };
}

module.exports = { getTeam, inviteMember, setMemberRole, removeMember, cancelInvite, REASON_TEXT };
