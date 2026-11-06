// รายได้ของ Kiwmee สำหรับ /super: MRR จากแพ็กเกจที่ยังไม่หมดอายุ · เงินที่ร้านเติมเดือนนี้ (cash in)
// · ยอดที่ใช้จริงจากกระเป๋า (orders) · ยอดคงเหลือในกระเป๋าทั้งระบบ (หนี้สินที่ยังไม่ให้บริการ)
//
// อ่านข้ามทุกแบรนด์ จึงใช้ connection ของเซิร์ฟเวอร์หลังยืนยันว่าเป็น platform admin เท่านั้น

const { ownerTx, PLAN_PRICES } = require("./wallet");
const { requirePlatformAdmin } = require("./platform-settings");

const PLAN_NAMES = { free: "ฟรี", starter: "เริ่มต้น", pro: "โปร", loyalty: "สมาชิก" };

/**
 * MRR: แพ็กเกจที่ยังไม่หมดอายุ (valid_until อยู่ในอนาคต หรือ null = ไม่มีกำหนด).
 * rows = [{ plan, valid_until }]
 */
function mrrOf(rows, now = new Date()) {
  let mrr = 0;
  let paying = 0;
  for (const row of rows ?? []) {
    const active = !row.valid_until || new Date(row.valid_until) > now;
    const price = PLAN_PRICES[row.plan] ?? 0;
    if (active && price > 0) {
      mrr += price;
      paying += 1;
    }
  }
  return { mrr, paying };
}

const MONTH_START = `(date_trunc('month', (now() at time zone 'Asia/Bangkok')) at time zone 'Asia/Bangkok')`;

const money = (value) => Number(value ?? 0);

async function revenueReport() {
  return ownerTx(async (client) => {
    await requirePlatformAdmin(client);

    const { rows: plans } = await client.query(
      `select b.id, b.name, p.plan, p.valid_until
         from public.brands b join public.brand_plans p on p.brand_id = b.id
        order by b.name`
    );

    // per-brand money this month: what they topped up (cash in) and what they spent from the balance
    const { rows } = await client.query(
      `select b.id, b.name, p.plan, p.valid_until,
              coalesce(a.balance, 0)::float8 as balance,
              coalesce(t.amount, 0)::float8 as topup,
              coalesce(o.amount, 0)::float8 as spend
         from public.brands b
         join public.brand_plans p on p.brand_id = b.id
         left join public.wallet_accounts a on a.brand_id = b.id
         left join (select brand_id, sum(credit_amount) as amount from public.wallet_topups
                     where status = 'credited' and credited_at >= ${MONTH_START}
                     group by brand_id) t on t.brand_id = b.id
         left join (select brand_id, sum(amount) as amount from public.wallet_orders
                     where status = 'paid' and created_at >= ${MONTH_START}
                     group by brand_id) o on o.brand_id = b.id
        order by coalesce(t.amount, 0) desc, b.name`
    );

    const { rows: [totals] } = await client.query(
      `select
         (select coalesce(sum(credit_amount), 0)::float8 from public.wallet_topups
           where status = 'credited' and credited_at >= ${MONTH_START}) as cash_in,
         (select coalesce(sum(amount), 0)::float8 from public.wallet_orders
           where status = 'paid' and created_at >= ${MONTH_START}) as spend,
         (select coalesce(sum(balance), 0)::float8 from public.wallet_accounts) as liability,
         (select count(*)::int from public.wallet_topups where status = 'pending') as pending`
    );

    const { rows: bySku } = await client.query(
      `select sku, count(*)::int as count, coalesce(sum(amount), 0)::float8 as amount
         from public.wallet_orders
        where status = 'paid' and created_at >= ${MONTH_START}
        group by sku order by amount desc`
    );

    const { mrr, paying } = mrrOf(plans);

    return {
      month: new Date().toLocaleDateString("th-TH", { year: "numeric", month: "long" }),
      mrr,
      payingBrands: paying,
      brands: rows.length,
      cashIn: money(totals?.cash_in),
      spend: money(totals?.spend),
      liability: money(totals?.liability),
      pendingTopups: totals?.pending ?? 0,
      bySku: bySku.map((s) => ({ sku: s.sku, count: s.count, amount: money(s.amount) })),
      perBrand: rows.map((r) => ({
        id: r.id,
        name: r.name,
        plan: r.plan,
        planName: PLAN_NAMES[r.plan] ?? r.plan,
        active: !r.valid_until || new Date(r.valid_until) > new Date(),
        validUntil: r.valid_until,
        monthly: PLAN_PRICES[r.plan] ?? 0,
        balance: money(r.balance),
        topup: money(r.topup),
        spend: money(r.spend)
      }))
    };
  });
}

function csvCell(value) {
  const text = value === null || value === undefined ? "" : String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** The same numbers as revenueReport(), as a CSV Excel opens correctly (BOM + CRLF). */
function revenueCsv(report) {
  const rows = [
    ["รายงานรายได้ Kiwmee", report.month],
    [],
    ["รายการ", "บาท"],
    ["MRR (แพ็กเกจที่ยังไม่หมดอายุ)", report.mrr],
    ["แบรนด์ที่จ่ายเงิน", report.payingBrands],
    ["เงินที่ร้านเติมเดือนนี้ (ยังไม่ใช่รายได้)", report.cashIn],
    ["ใช้จากกระเป๋าเดือนนี้ (รายได้ที่รับรู้)", report.spend],
    ["ยอดคงเหลือในกระเป๋าทั้งระบบ (หนี้สิน)", report.liability],
    ["สลิปรอตรวจ", report.pendingTopups],
    [],
    ["สินค้า", "จำนวน", "ยอดเงิน"],
    ...report.bySku.map((s) => [s.sku, s.count, s.amount]),
    [],
    ["แบรนด์", "แพ็กเกจ", "วันหมดอายุ", "เติมเดือนนี้", "ใช้เดือนนี้", "คงเหลือ"],
    ...report.perBrand.map((b) => [
      b.name,
      b.planName,
      b.validUntil ? new Date(b.validUntil).toISOString().slice(0, 10) : "",
      b.topup,
      b.spend,
      b.balance
    ])
  ];
  return "\uFEFF" + rows.map((row) => row.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

module.exports = { PLAN_PRICES, mrrOf, revenueReport, revenueCsv };
