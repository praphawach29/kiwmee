// B8 (docs/BILLING_PLAN.md 4, migration …004500): Kiwmee tells brand owners in LINE about their plan.
//
//   Linking: the dashboard asks for a one-time link (startLink) and shows it as a QR code. The owner
//   opens it in LINE (/b/owner-line/<code>), LINE's ID token says who they are (finishLink), and
//   notices go to that LINE account from Kiwmee's central Official Account.
//   Notices (sendOwnerNotices, every hour with the plan renewals, 09:00–20:00 Bangkok):
//     expiring  7 / 3 / 1 days before a plan ends: trial, free period, ending, or a wallet that is short
//               (a wallet that can pay hears it once: "it renews itself, N baht")
//     grace     the plan ended and the wallet could not pay: usable until the grace day, then free
//     usage     this month's online bookings / LINE messages / slip checks pass 80% and 100%
//   Each is claimed in owner_notices before it is sent, so it goes out once. Owner notices do not
//   count against the shop's monthly LINE messages.

const crypto = require("node:crypto");
const QRCode = require("qrcode");
const { AppError, badRequest } = require("../errors");
const { getSetting } = require("./platform-settings");
const { pushLine } = require("./line-notify");
const { publicOrigin } = require("./scan-codes");
const { ownerTx, quotaOf } = require("./wallet");
const { planById, priceOf } = require("./plans");

const ZONE = "Asia/Bangkok";
const DAY_MS = 24 * 3600 * 1000;
const STEPS = [1, 3, 7]; // days before the end
const LINK_MINUTES = 15;
const CODE = /^[A-Za-z0-9_-]{24}$/;

const GRAPE = "#6A4CFF";
const INK = "#1B1640";
const MUTED = "#5F5A7A";
const WARN = "#B54708";
const DANGER = "#B42318";

const hourIn = (now) => Number(new Intl.DateTimeFormat("en-GB", { timeZone: ZONE, hour: "2-digit", hourCycle: "h23" }).format(now));
const dayKey = (iso) => new Intl.DateTimeFormat("en-CA", { timeZone: ZONE, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));
const thaiDate = (iso) => new Intl.DateTimeFormat("th-TH", { timeZone: ZONE, day: "numeric", month: "short", year: "numeric" }).format(new Date(iso));
const baht = (n) => `${Math.ceil(Number(n) || 0).toLocaleString("th-TH")} บาท`;
const count = (n) => Number(n).toLocaleString("th-TH");
const hashCode = (code) => crypto.createHash("sha256").update(code).digest("hex");

/** Whole days until `end`, rounded up (ends in 30 hours = 2 days) */
const daysLeft = (end, now) => Math.ceil((new Date(end) - now) / DAY_MS);

const USAGE = {
  bookings: {
    title: "การจองออนไลน์",
    warn: (u) => `การจองออนไลน์เดือนนี้ใช้ไป ${count(u.used)} จาก ${count(u.total)} ครั้ง · ครบแล้วหน้าจองจะปิดรับจองออนไลน์จนถึงต้นเดือนหน้า`,
    full: (u) => `การจองออนไลน์เดือนนี้ครบ ${count(u.total)} ครั้งแล้ว · หน้าจองปิดรับจองออนไลน์จนถึงต้นเดือนหน้า (ร้านยังลงคิวเองในแดชบอร์ดได้)`,
    action: "อัปเกรดเป็นแพ็กเกจเริ่มต้นเพื่อรับจองไม่จำกัด"
  },
  messages: {
    title: "ข้อความ LINE",
    warn: (u) => `ข้อความ LINE เดือนนี้ใช้ไป ${count(u.used)} จาก ${count(u.total)} ข้อความ`,
    full: (u) => `ข้อความ LINE เดือนนี้ครบ ${count(u.total)} ข้อความแล้ว · การ์ด LINE ถึงลูกค้า (ยืนยัน/เตือนนัด) หยุดส่งจนถึงต้นเดือนหน้า`,
    action: "ซื้อข้อความเพิ่มได้จากกระเป๋าเงิน"
  },
  slips: {
    title: "ตรวจสลิปอัตโนมัติ",
    warn: (u) => `ตรวจสลิปอัตโนมัติเดือนนี้ใช้ไป ${count(u.used)} จาก ${count(u.total)} ครั้ง`,
    full: (u) => `ตรวจสลิปอัตโนมัติเดือนนี้ครบ ${count(u.total)} ครั้งแล้ว · สลิปใหม่ร้านต้องตรวจเองจนถึงต้นเดือนหน้า`,
    action: "ซื้อการตรวจสลิปเพิ่มได้จากกระเป๋าเงิน"
  }
};

/**
 * What a brand should hear now (pure): [{ kind, key, claimAlso: [keys], tone, title, lines, button }].
 * state = { brandName, plan, cycle, validUntil, complimentary, trial, autoRenew, nextPlan, nextCycle,
 *           graceUntil, balance, period ("2026-11-01"), usage: { bookings|messages|slips: { used, total } } }
 * A total of null (unlimited) or 0 (not in the plan) is never warned about.
 */
function dueNotices(state, now = new Date()) {
  const notices = [];
  const plan = planById(state.plan);
  const renewPlan = planById(state.nextPlan ?? state.plan);
  const renewCycle = state.nextCycle ?? state.cycle ?? "month";
  const renewAmount = priceOf(renewPlan.id, renewCycle);
  const short = Math.max(0, renewAmount - (Number(state.balance) || 0));
  const end = state.validUntil ? new Date(state.validUntil) : null;
  const grace = state.graceUntil ? new Date(state.graceUntil) : null;

  if (state.plan !== "free" && end && end <= now && grace && grace > now) {
    notices.push({
      kind: "grace",
      key: dayKey(grace),
      tone: "danger",
      title: `แพ็กเกจ${plan.name}หมดแล้ว`,
      lines: [
        `เงินในกระเป๋าไม่พอต่ออายุ · ยังใช้งานได้ถึง ${thaiDate(grace)} แล้วจะกลับเป็นแพ็กเกจฟรี`,
        `เติมเงินอีก ${baht(short)} ระบบจะต่ออายุแพ็กเกจ${renewPlan.name}ให้อัตโนมัติ`
      ],
      button: "เติมเงิน"
    });
  } else if (state.plan !== "free" && end && end > now) {
    const left = daysLeft(end, now);
    const step = STEPS.find((t) => left <= t);
    if (step) {
      const when = `${thaiDate(end)} (อีก ${left} วัน)`;
      const at = (suffix) => `${dayKey(end)}:${suffix}`;
      if (state.trial) {
        notices.push({
          kind: "expiring", key: at(step), tone: "warn",
          title: `ช่วงทดลองแพ็กเกจ${plan.name}ใกล้หมด`,
          lines: [`ทดลองใช้ได้ถึง ${when} · หลังจากนั้นร้านจะเป็นแพ็กเกจฟรี`, "เลือกแพ็กเกจที่ใช่เพื่อใช้ฟีเจอร์ต่อ"],
          button: "เลือกแพ็กเกจ"
        });
      } else if (state.complimentary) {
        notices.push({
          kind: "expiring", key: at(step), tone: "warn",
          title: `แพ็กเกจ${plan.name}ที่ใช้ฟรีใกล้หมด`,
          lines: [`ใช้ฟรีถึง ${when} · หลังจากนั้นร้านจะเป็นแพ็กเกจฟรี`, "ซื้อแพ็กเกจไว้ล่วงหน้าได้เลย วันที่ซื้อจะนับต่อจากวันที่ใช้ฟรี"],
          button: "เลือกแพ็กเกจ"
        });
      } else if (state.autoRenew === false || state.nextPlan === "free") {
        notices.push({
          kind: "expiring", key: at(step), tone: "warn",
          title: `แพ็กเกจ${plan.name}ใกล้หมด`,
          lines: [`ใช้ได้ถึง ${when} · ปิดการต่ออายุอัตโนมัติไว้ หลังจากนั้นร้านจะเป็นแพ็กเกจฟรี`],
          button: "ดูแพ็กเกจ"
        });
      } else if (short > 0) {
        notices.push({
          kind: "expiring", key: at(step), tone: step === 1 ? "danger" : "warn",
          title: "เงินในกระเป๋าไม่พอต่ออายุ",
          lines: [
            `แพ็กเกจ${plan.name}หมด ${when} · ต่ออายุ${renewPlan.name}${renewCycle === "year" ? " 1 ปี" : " 1 เดือน"} ${baht(renewAmount)}`,
            `ในกระเป๋ามี ${baht(state.balance)} · เติมอีก ${baht(short)} ระบบจะต่ออายุให้อัตโนมัติ`
          ],
          button: "เติมเงิน"
        });
      } else {
        // the wallet can pay: one heads-up is enough
        notices.push({
          kind: "expiring", key: at("funded"), tone: "info",
          title: `แพ็กเกจ${plan.name}จะต่ออายุอัตโนมัติ`,
          lines: [`รอบนี้หมด ${when} · ระบบจะหักจากกระเป๋า ${baht(renewAmount)} (ในกระเป๋ามี ${baht(state.balance)})`],
          button: "ดูแพ็กเกจ"
        });
      }
    }
  }

  for (const [metric, text] of Object.entries(USAGE)) {
    const u = state.usage?.[metric];
    if (!u || !u.total || u.total <= 0) continue;
    const percent = (u.used / u.total) * 100;
    if (percent < 80) continue;
    const full = percent >= 100;
    const key = (level) => `${state.period}:${metric}:${level}`;
    notices.push({
      kind: "usage",
      key: key(full ? 100 : 80),
      claimAlso: full ? [key(80)] : [],
      tone: full ? "danger" : "warn",
      title: full ? `${text.title}เดือนนี้ครบแล้ว` : `${text.title} ใช้ไป ${Math.floor(percent)}%`,
      lines: [full ? text.full(u) : text.warn(u), text.action],
      button: "ดูแพ็กเกจ"
    });
  }
  return notices;
}

const TONE = { info: GRAPE, warn: WARN, danger: DANGER };

/** The LINE card for one notice (Flex) */
function noticeCard(notice, { brandName, link }) {
  const color = TONE[notice.tone] ?? GRAPE;
  const bubble = {
    type: "bubble",
    size: "kilo",
    header: {
      type: "box",
      layout: "vertical",
      paddingAll: "16px",
      backgroundColor: color,
      contents: [
        { type: "text", text: `Kiwmee · ${brandName}`, size: "xs", color: "#FFFFFFCC", wrap: true },
        { type: "text", text: notice.title, size: "md", weight: "bold", color: "#FFFFFF", wrap: true, margin: "sm" }
      ]
    },
    body: {
      type: "box",
      layout: "vertical",
      spacing: "md",
      paddingAll: "16px",
      contents: notice.lines.map((line, i) => ({ type: "text", text: line, size: "sm", color: i === 0 ? INK : MUTED, wrap: true }))
    }
  };
  if (link) {
    bubble.footer = {
      type: "box",
      layout: "vertical",
      paddingAll: "12px",
      contents: [{ type: "button", style: "primary", color: GRAPE, height: "sm", action: { type: "uri", label: notice.button, uri: link } }]
    };
  }
  return { type: "flex", altText: `${brandName}: ${notice.title}`, contents: bubble };
}

/** Brands with at least one owner who linked LINE, and what they need to judge the notices */
async function brandStates(db) {
  const { rows } = await db.query(
    `select b.id as brand_id, b.name as brand_name, p.plan, p.cycle, p.valid_until, coalesce(p.complimentary, false) as complimentary,
            coalesce(p.trial, false) as trial, p.auto_renew, p.next_plan, p.next_cycle, p.grace_until,
            public.brand_plan(b.id) as effective, coalesce(a.balance, 0)::float8 as balance,
            date_trunc('month', now() at time zone '${ZONE}')::date::text as period,
            public.brand_month_online_bookings(b.id) as bookings_used,
            public.plan_limit(public.brand_plan(b.id), 'bookings_per_month') as bookings_total,
            coalesce(u.messages_used, 0) as messages_used, coalesce(u.messages_included, 0) as messages_included,
            coalesce(u.messages_purchased, 0) as messages_purchased, coalesce(u.slips_used, 0) as slips_used,
            public.plan_limit(public.brand_plan(b.id), 'slip_checks') as slips_included,
            (select count(*)::int * 100 from public.wallet_orders o
              where o.brand_id = b.id and o.sku = 'slip:100' and o.status = 'paid'
                and o.created_at >= date_trunc('month', now() at time zone '${ZONE}') at time zone '${ZONE}') as slips_purchased,
            array_agg(distinct l.line_user_id) as recipients
       from public.brands b
       join public.brand_members m on m.brand_id = b.id
       join public.owner_line_links l on l.user_id = m.user_id and l.line_user_id is not null
       left join public.brand_plans p on p.brand_id = b.id
       left join public.wallet_accounts a on a.brand_id = b.id
       left join public.usage_counters u on u.brand_id = b.id and u.period = date_trunc('month', now() at time zone '${ZONE}')::date
      group by b.id, p.brand_id, a.brand_id, u.brand_id, u.period`
  );
  return rows.map((r) => {
    const messages = quotaOf(r.effective, { messagesUsed: r.messages_used, messagesIncluded: r.messages_included, messagesPurchased: r.messages_purchased });
    const slipsTotal = r.slips_included === null ? null : r.slips_included + r.slips_purchased;
    return {
      brandId: r.brand_id,
      brandName: r.brand_name,
      recipients: r.recipients,
      plan: r.plan ?? "free",
      cycle: r.cycle ?? "month",
      validUntil: r.valid_until,
      complimentary: r.complimentary,
      trial: r.trial,
      autoRenew: r.auto_renew,
      nextPlan: r.next_plan,
      nextCycle: r.next_cycle,
      graceUntil: r.grace_until,
      balance: r.balance,
      period: r.period,
      usage: {
        bookings: { used: r.bookings_used, total: r.bookings_total },
        messages: { used: messages.used, total: messages.total },
        slips: { used: r.slips_used, total: slipsTotal }
      }
    };
  });
}

/**
 * Sends what is due now. Returns { brands, sent, skipped } for the log. Outside 09:00–20:00 Bangkok: nothing.
 * push(to, messages) is injectable for tests; db is the server's pool (the database owner).
 */
async function sendOwnerNotices(db, { now = new Date(), push = (to, messages) => pushLine(db, to, messages), env = process.env, anyHour = false } = {}) {
  const hour = hourIn(now);
  if (!anyHour && (hour < 9 || hour >= 20)) return { brands: 0, sent: 0, skipped: 0 };
  const origin = publicOrigin(env);
  const states = await brandStates(db);
  let sent = 0;
  let skipped = 0;
  for (const state of states) {
    for (const notice of dueNotices(state, now)) {
      try {
        const claim = await db.query(
          "insert into public.owner_notices (brand_id, kind, key) values ($1, $2, $3) on conflict do nothing returning key",
          [state.brandId, notice.kind, notice.key]
        );
        for (const key of notice.claimAlso ?? []) {
          await db.query("insert into public.owner_notices (brand_id, kind, key, result) values ($1, $2, $3, 'covered') on conflict do nothing", [state.brandId, notice.kind, key]);
        }
        if (!claim.rowCount) {
          skipped++;
          continue;
        }
        const link = origin ? `${origin}/dashboard/wallet?brand=${state.brandId}` : null;
        const card = noticeCard(notice, { brandName: state.brandName, link });
        const results = [];
        for (const to of state.recipients) results.push(await push(to, [card]).catch(() => ({ sent: false, reason: "ERROR" })));
        const delivered = results.some((r) => r?.sent);
        if (delivered) sent++;
        await db.query("update public.owner_notices set result = $4 where brand_id = $1 and kind = $2 and key = $3", [
          state.brandId,
          notice.kind,
          notice.key,
          delivered ? "sent" : String(results[0]?.reason ?? "ERROR").slice(0, 40)
        ]);
      } catch (error) {
        console.error("[owner-notices] not sent:", error.message);
      }
    }
  }
  return { brands: states.length, sent, skipped };
}

// ---------- linking an owner's LINE ----------

const welcome = (lineName) => ({
  type: "text",
  text: `เชื่อม LINE${lineName ? ` (${lineName})` : ""} กับ Kiwmee แล้ว ✓\nต่อจากนี้จะแจ้งเตือนที่นี่เมื่อแพ็กเกจใกล้หมด เงินในกระเป๋าไม่พอต่ออายุ หรือใช้งานใกล้เต็มโควตา`
});

/** Where this dashboard user's notices go: { linked, lineName, linkedAt } */
async function linkStatus(userId) {
  return ownerTx(async (client) => {
    const { rows: [row] } = await client.query("select line_user_id, line_name, linked_at from public.owner_line_links where user_id = $1", [userId]);
    return { linked: Boolean(row?.line_user_id), lineName: row?.line_name ?? null, linkedAt: row?.linked_at ?? null };
  });
}

/** A new one-time link (15 minutes) to open in LINE: { url, qr (data URL), expiresAt } */
async function startLink(userId, { env = process.env } = {}) {
  return ownerTx(async (client) => {
    const liffId = await getSetting(client, "line.liff_id", { env });
    if (!liffId) throw new AppError("NOT_CONFIGURED", "ยังไม่ได้ตั้ง LIFF ของ Kiwmee (ทีมงานตั้งได้ที่ /super)", 503);
    const code = crypto.randomBytes(18).toString("base64url");
    const expiresAt = new Date(Date.now() + LINK_MINUTES * 60 * 1000);
    await client.query(
      `insert into public.owner_line_links (user_id, code_hash, code_expires_at) values ($1, $2, $3)
       on conflict (user_id) do update set code_hash = excluded.code_hash, code_expires_at = excluded.code_expires_at, updated_at = now()`,
      [userId, hashCode(code), expiresAt]
    );
    const url = `https://liff.line.me/${liffId}/owner-line/${code}`;
    const qr = await QRCode.toDataURL(url, { errorCorrectionLevel: "M", margin: 1, width: 360, color: { dark: "#1B1640", light: "#FFFFFF" } });
    return { url, qr, expiresAt: expiresAt.toISOString() };
  });
}

/** Stop the notices: forget the LINE account */
async function unlink(userId) {
  return ownerTx(async (client) => {
    await client.query(
      "update public.owner_line_links set line_user_id = null, line_name = null, linked_at = null, code_hash = null, code_expires_at = null, updated_at = now() where user_id = $1",
      [userId]
    );
    return { linked: false };
  });
}

/** Send the welcome message again (did it arrive? the owner may need to add the OA as a friend) */
async function testLink(userId, { push = null } = {}) {
  return ownerTx(async (client) => {
    const { rows: [row] } = await client.query("select line_user_id, line_name from public.owner_line_links where user_id = $1", [userId]);
    if (!row?.line_user_id) throw badRequest("ยังไม่ได้เชื่อม LINE");
    const send = push ?? ((to, messages) => pushLine(client, to, messages));
    const result = await send(row.line_user_id, [welcome(row.line_name)]);
    return { delivered: Boolean(result?.sent) };
  });
}

/**
 * The page in LINE (/b/owner-line/<code>): body = { code, lineIdToken }. LINE says who it is, the code
 * says which dashboard user. The code works once. → { linked: true, lineName, delivered }
 * verifyLineToken(token) → { sub, name } | null and push are injected so tests need no network.
 */
async function finishLink(db, body = {}, { verifyLineToken, push = (to, messages) => pushLine(db, to, messages) } = {}) {
  const code = typeof body.code === "string" ? body.code : "";
  if (!CODE.test(code)) throw badRequest("ลิงก์ไม่ถูกต้อง");
  if (typeof body.lineIdToken !== "string" || !body.lineIdToken) throw new AppError("LINE_REQUIRED", "เปิดลิงก์นี้ใน LINE แล้วเข้าสู่ระบบ LINE ก่อน", 401);
  const line = await verifyLineToken(body.lineIdToken);
  if (!line?.sub || !/^U[0-9a-f]{32}$/.test(line.sub)) throw new AppError("LINE_REQUIRED", "ยืนยันบัญชี LINE ไม่สำเร็จ ลองเปิดลิงก์ใหม่อีกครั้ง", 401);
  const lineName = typeof line.name === "string" ? line.name.slice(0, 120) : null;
  const { rows: [row] } = await db.query(
    `update public.owner_line_links
        set line_user_id = $2, line_name = $3, linked_at = now(), code_hash = null, code_expires_at = null, updated_at = now()
      where code_hash = $1 and code_expires_at > now()
      returning user_id`,
    [hashCode(code), line.sub, lineName]
  );
  if (!row) throw new AppError("LINK_EXPIRED", "ลิงก์นี้หมดอายุหรือใช้ไปแล้ว · กลับไปกด \"เชื่อม LINE\" ในแดชบอร์ดเพื่อรับลิงก์ใหม่", 410);
  const result = await Promise.resolve(push(line.sub, [welcome(lineName)])).catch(() => null);
  return { linked: true, lineName, delivered: Boolean(result?.sent) };
}

/** POST /api/dashboard/line-link: { action: "status" | "start" | "unlink" | "test" } */
async function linkAction(userId, input = {}) {
  if (input.action === "status") return linkStatus(userId);
  if (input.action === "start") return startLink(userId);
  if (input.action === "unlink") return unlink(userId);
  if (input.action === "test") return testLink(userId);
  throw badRequest("ไม่รู้จักคำสั่งนี้");
}

module.exports = { dueNotices, noticeCard, daysLeft, sendOwnerNotices, linkAction, linkStatus, startLink, unlink, testLink, finishLink, hashCode };
