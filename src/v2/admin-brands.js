// Brands and branches (docs/LOYALTY_DESIGN.md §2, step 6c), for /dashboard: the user's brands with
// their branches and plan, renaming a brand, adding a branch set up like an existing one, and
// bringing a shop the user already owns into a brand.
//
// Every function takes a client running as the signed-in user (admin-catalog.js asUser): RLS limits
// what is read to the user's brands, and the RPCs (migration …001100) check brand ownership and the
// plan's branch limit again.

const { AppError, badRequest, notFound } = require("../errors");
const { quotaOf } = require("./wallet");

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SLUG = /^[a-z0-9][a-z0-9-]{1,40}$/;
const PLAN_NAMES = { free: "ฟรี", starter: "เริ่มต้น", pro: "โปร", loyalty: "สมาชิก" };

const REASON_TEXT = {
  PLAN_LIMIT: "แพ็กเกจของแบรนด์นี้มีได้ 1 สาขา อัปเกรดเป็นแพ็กเกจโปรเพื่อเพิ่มสาขา",
  SAME_BRAND: "ร้านนี้อยู่ในแบรนด์นี้อยู่แล้ว",
  NOT_OWNER: "ต้องเป็นเจ้าของทั้งร้านและแบรนด์",
  NOT_FOUND: "ไม่พบแบรนด์หรือร้านนี้"
};

function rpcError(error) {
  if (error?.code === "BK404") return notFound(REASON_TEXT.NOT_FOUND);
  if (error?.code === "BK422") return new AppError("UNAVAILABLE", REASON_TEXT[error.message] ?? error.message, 422, { reason: error.message });
  if (error?.code === "42501") return new AppError("FORBIDDEN", "เฉพาะเจ้าของแบรนด์ทำได้", 403);
  return error;
}

async function rpc(client, sql, params) {
  try {
    return (await client.query(sql, params)).rows[0];
  } catch (error) {
    throw rpcError(error);
  }
}

const invalid = (message) => new AppError("INVALID", message, 422);

function name(value, label) {
  const v = typeof value === "string" ? value.trim() : "";
  if (!v) throw invalid(`กรุณากรอก${label}`);
  if (v.length > 120) throw invalid(`${label}ยาวเกินไป`);
  return v;
}

function slug(value) {
  const v = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!SLUG.test(v)) throw invalid("ชื่อลิงก์ใช้ได้เฉพาะ a-z 0-9 และ - (2–41 ตัว)");
  return v;
}

function brandId(value) {
  if (typeof value !== "string" || !UUID.test(value)) throw notFound(REASON_TEXT.NOT_FOUND);
  return value;
}

/** The user's brands: plan, whether they own it, and the branches they work at (taking up open invites first). */
async function listBrands(client) {
  // invites to the caller's confirmed email (admin-team.js) become memberships before we list.
  // A database that has not run migration …001700 yet must still open its dashboard — the invite
  // step is a convenience, not a reason to show an English Postgres error to the shop owner.
  // An error inside a Postgres transaction aborts it (25P02 for everything after), so the optional
  // step runs inside a savepoint: a database without migration …001700 still gets its dashboard.
  await client.query("savepoint invites");
  try {
    await client.query("select public.accept_my_invites()");
    await client.query("release savepoint invites");
  } catch (error) {
    if (error.code !== "42883" && error.code !== "42P01") throw error; // not "missing function/table"
    await client.query("rollback to savepoint invites");
    console.warn("[brands] invites not taken up — migration …001700 is missing:", error.message);
  }
  const { rows } = await client.query(
    `select br.id, br.name, public.brand_plan(br.id) as plan, p.valid_until, public.is_brand_owner(br.id) as owner,
            public.brand_branch_limit(public.brand_plan(br.id)) as branch_limit,
            (select count(*)::int from public.businesses x where x.brand_id = br.id) as branch_count,
            coalesce(u.messages_used, 0) as messages_used,
            coalesce(u.messages_included, 0) as messages_included,
            coalesce(u.messages_purchased, 0) as messages_purchased,
            coalesce((select json_agg(json_build_object('slug', b.slug, 'name', b.name, 'kind', b.kind, 'role', m.role) order by b.name)
                        from public.businesses b
                        join public.business_members m on m.business_id = b.id and m.user_id = auth.uid()
                       where b.brand_id = br.id), '[]'::json) as shops
       from public.brands br
       left join public.brand_plans p on p.brand_id = br.id
       left join public.usage_counters u
              on u.brand_id = br.id
             and u.period = date_trunc('month', (now() at time zone 'Asia/Bangkok'))::date
      order by br.name`
  );
  return rows.map((r) => {
    // how much of this month's LINE messages the brand used (shown in /dashboard; nothing is blocked)
    const quota = quotaOf(r.plan, {
      messagesUsed: r.messages_used,
      messagesIncluded: r.messages_included,
      messagesPurchased: r.messages_purchased
    });
    return {
      id: r.id,
      name: r.name,
      plan: r.plan,
      planName: PLAN_NAMES[r.plan] ?? r.plan,
      planValidUntil: r.valid_until ?? null,
      planDaysLeft: r.valid_until ? Math.ceil((new Date(r.valid_until) - new Date()) / 86400000) : null,
      owner: r.owner,
      branchLimit: r.branch_limit,
      branchCount: r.branch_count,
      messagesUsed: quota.used,
      messagesTotal: quota.total,
      quotaPercent: quota.percent,
      quotaLevel: quota.level,
      shops: r.shops
    };
  });
}

async function renameBrand(client, id, input = {}) {
  const { rowCount } = await client.query("update public.brands set name = $2 where id = $1", [brandId(id), name(input.name, "ชื่อแบรนด์")]);
  if (!rowCount) throw notFound(REASON_TEXT.NOT_FOUND);
  return { id };
}

async function shopIdInBrand(client, brand, shopSlug) {
  const { rows } = await client.query("select id from public.businesses where slug = $1 and brand_id = $2", [slug(shopSlug), brand]);
  if (!rows[0]) throw notFound("ไม่พบสาขาต้นแบบในแบรนด์นี้");
  return rows[0].id;
}

/** { name, slug, copyFrom?: branch slug, copyResources?: boolean } → the new branch's slug */
async function addBranch(client, id, input = {}) {
  const brand = brandId(id);
  const newSlug = slug(input.slug);
  const copyFrom = input.copyFrom ? await shopIdInBrand(client, brand, input.copyFrom) : null;
  if (input.copyResources !== undefined && typeof input.copyResources !== "boolean") throw badRequest("copyResources must be true or false");
  await rpc(client, "select public.add_branch($1, $2, $3, $4, $5) as id", [
    brand,
    name(input.name, "ชื่อสาขา"),
    newSlug,
    copyFrom,
    Boolean(copyFrom && input.copyResources)
  ]);
  return { slug: newSlug };
}

/** { slug } — a shop the user owns, moved into this brand */
async function moveShop(client, id, input = {}) {
  const brand = brandId(id);
  const { rows } = await client.query("select id from public.businesses where slug = $1", [slug(input.slug)]);
  if (!rows[0]) throw notFound(REASON_TEXT.NOT_FOUND);
  await rpc(client, "select public.move_business_to_brand($1, $2)", [rows[0].id, brand]);
  return { id: brand };
}

module.exports = { listBrands, renameBrand, addBranch, moveShop, REASON_TEXT };
