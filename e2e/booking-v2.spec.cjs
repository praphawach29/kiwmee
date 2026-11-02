// The v2 booking page (design step 4) against the demo shops in supabase/seed.sql.
// Needs the app running with BOOKING_DB_URL pointing at a database built by scripts/db-test.sh:
//   BOOKING_DB_URL=postgres://… BOOKING_BOOK_LIMIT=100 npx next dev -p 3100
//   PILOT_BASE_URL=http://127.0.0.1:3100 npx playwright test e2e/booking-v2.spec.cjs
// Dates and times are picked from what the page offers, so the tests do not depend on the day.
const { test, expect } = require("@playwright/test");

test.use({ viewport: { width: 390, height: 844 } });

const enabled = (page, step) => page.locator(`[data-testid="option-${step}"]:not([disabled])`);

async function fillAndConfirm(page, name) {
  await page.getByLabel("ชื่อ").fill(name);
  await page.getByLabel(/เบอร์โทร/).fill("0812345678");
  await page.getByRole("button", { name: "ยืนยันการจอง" }).click();
}

test("salon: start from a date, then offering, anyone, time", async ({ page }) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/b/bloom-hair");
  await expect(page.getByRole("heading", { name: "เริ่มจองจาก" })).toBeVisible();
  await page.getByRole("button", { name: /เลือกวันก่อน/ }).click();

  await expect(page.getByRole("heading", { name: "เลือกวัน" })).toBeVisible();
  await expect(page.locator('[data-testid="option-date"]').first()).toContainText(/วันนี้|จ\.|อ\.|พ\.|พฤ\.|ศ\.|ส\.|อา\./);
  await enabled(page, "date").nth(2).click();

  await expect(page.getByRole("heading", { name: "เลือกบริการ" })).toBeVisible();
  await page.getByRole("button", { name: /ตัดผมหญิง/ }).click();

  await expect(page.getByRole("heading", { name: "เลือกช่าง" })).toBeVisible();
  // ช่างพลอย does colour only, so she is not offered for a cut
  await expect(page.locator('[data-testid="option-resource"]')).not.toContainText(["ช่างพลอย"]);
  await page.getByRole("button", { name: "ช่างคนไหนก็ได้" }).click();

  await expect(page.getByRole("heading", { name: "เลือกเวลา" })).toBeVisible();
  await enabled(page, "time").first().click();

  await fillAndConfirm(page, "ลูกค้าเริ่มจากวัน");
  const done = page.getByTestId("booking-done");
  await expect(done).toContainText("จองสำเร็จ");
  await expect(done).toContainText("450 บาท");
  await expect(done).toContainText(/ช่าง(แนน|บี)/);
  expect(errors).toEqual([]);
});

test("salon: start from an offering, pick the colourist, then date and time", async ({ page }) => {
  await page.goto("/b/bloom-hair");
  await page.getByRole("button", { name: /เลือกบริการก่อน/ }).click();
  await page.getByRole("button", { name: /ทำสีผม/ }).click();
  await page.getByRole("button", { name: "ช่างพลอย (ทำสีเท่านั้น)" }).click();
  await expect(page.getByRole("heading", { name: "เลือกวัน" })).toBeVisible();
  await enabled(page, "date").nth(3).click();
  await enabled(page, "time").first().click();
  await fillAndConfirm(page, "ลูกค้าเริ่มจากบริการ");
  const done = page.getByTestId("booking-done");
  await expect(done).toContainText("จองสำเร็จ");
  await expect(done).toContainText("ช่างพลอย");
  await expect(done).toContainText("1,500 บาท");
});

test("salon: going back to change the offering drops a stylist who does not do it", async ({ page }) => {
  await page.goto("/b/bloom-hair");
  await page.getByRole("button", { name: /เลือกบริการก่อน/ }).click();
  await page.getByRole("button", { name: /ทำสีผม/ }).click();
  await page.getByRole("button", { name: "ช่างพลอย (ทำสีเท่านั้น)" }).click();
  await expect(page.getByRole("heading", { name: "เลือกวัน" })).toBeVisible();

  // tap the offering chip and switch to a cut
  await page.getByRole("button", { name: /ทำสีผม\s*เปลี่ยน/ }).click();
  await page.getByRole("button", { name: /ตัดผมหญิง/ }).click();
  await expect(page.getByRole("status")).toContainText("ช่างพลอย (ทำสีเท่านั้น) ไม่มีบริการนี้");
  await expect(page.getByRole("heading", { name: "เลือกช่าง" })).toBeVisible();
  await expect(page.getByRole("button", { name: /ตัดผมหญิง.*เปลี่ยน/ })).toBeVisible();
});

test("barber: always starts from the offering; Mondays are greyed out as closed", async ({ page }) => {
  await page.goto("/b/gentleman-barber");
  await expect(page.getByRole("heading", { name: "เริ่มจองจาก" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "เลือกบริการ" })).toBeVisible();
  await page.getByRole("button", { name: /ตัดผมชาย/ }).click();

  await expect(page.getByRole("heading", { name: "เลือกวัน" })).toBeVisible();
  await expect(page.locator('[data-testid="option-date"][disabled]').filter({ hasText: "ร้านปิด" }).first()).toBeVisible();
  await enabled(page, "date").nth(1).click();
  // no barber to pick: the shop assigns one
  await expect(page.getByRole("heading", { name: "เลือกเวลา" })).toBeVisible();
  await enabled(page, "time").first().click();
  await fillAndConfirm(page, "ลูกค้าร้านตัดผม");
  const done = page.getByTestId("booking-done");
  await expect(done).toContainText("จองสำเร็จ");
  await expect(done).toContainText(/ช่าง(โต้ง|เอก)/);
});

test("two customers on one slot: the second is told it was just taken and picks again", async ({ browser }) => {
  const a = await browser.newPage();
  const b = await browser.newPage();
  for (const page of [a, b]) {
    await page.goto("/b/bloom-hair");
    await page.getByRole("button", { name: /เลือกบริการก่อน/ }).click();
    await page.locator('[data-testid="option-offering"]', { hasText: "ทรีตเมนต์" }).click();
    await page.getByRole("button", { name: "ช่างแนน" }).click();
    await enabled(page, "date").nth(5).click();
    await enabled(page, "time").first().click();
    await expect(page.getByRole("button", { name: "ยืนยันการจอง" })).toBeVisible();
  }
  await fillAndConfirm(a, "ลูกค้า A");
  await expect(a.getByTestId("booking-done")).toContainText("จองสำเร็จ");

  await fillAndConfirm(b, "ลูกค้า B");
  await expect(b.getByRole("status")).toContainText("เพิ่งถูกจอง");
  await expect(b.getByRole("heading", { name: "เลือกเวลา" })).toBeVisible();
  await enabled(b, "time").first().click();
  await fillAndConfirm(b, "ลูกค้า B");
  await expect(b.getByTestId("booking-done")).toContainText("จองสำเร็จ");
});

test("the customer opens their link, moves the booking, then cancels it", async ({ page }) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/b/bloom-hair");
  await page.getByRole("button", { name: /เลือกบริการก่อน/ }).click();
  await page.locator('[data-testid="option-offering"]', { hasText: "ทรีตเมนต์" }).click();
  await page.getByRole("button", { name: "ช่างบี" }).click();
  await enabled(page, "date").nth(4).click();
  await enabled(page, "time").first().click();
  await fillAndConfirm(page, "ลูกค้าเลื่อนเอง");
  await expect(page.getByTestId("booking-done")).toContainText("เลื่อนหรือยกเลิกนัดเองได้");

  await page.getByTestId("manage-link").click();
  await expect(page).toHaveURL(/\/b\/bloom-hair\/manage\/[A-Za-z0-9_-]{32}$/);
  await page.waitForLoadState("networkidle"); // the buttons work once the page has hydrated
  const card = page.getByTestId("manage-booking");
  await expect(card).toContainText("ทรีตเมนต์บำรุงผม");
  await expect(card).toContainText("ช่างบี");
  await expect(card).toContainText("ยืนยันแล้ว");

  await page.getByRole("button", { name: "เลื่อนนัด" }).click();
  await enabled(page, "date").nth(2).click();
  const time = enabled(page, "time").nth(1);
  const value = await time.getAttribute("data-value");
  await time.click();
  await page.getByRole("button", { name: `ยืนยันเลื่อนเป็น ${value} น.` }).click();
  await expect(page.getByRole("status")).toContainText(`เวลา ${value} น. แล้ว`);
  await expect(card).toContainText(`${value}–`);
  await expect(card).toContainText("ช่างบี", { timeout: 1000 });

  await page.getByRole("button", { name: "ยกเลิกการจอง" }).click();
  await page.getByLabel(/เหตุผล/).fill("ติดธุระ");
  await page.getByRole("button", { name: "ยืนยันยกเลิก" }).click();
  await expect(card).toContainText("ยกเลิกแล้ว");
  await expect(page.getByRole("button", { name: "เลื่อนนัด" })).toHaveCount(0);
  expect(errors).toEqual([]);

  // a made-up link finds nothing
  const missing = await page.goto("/b/bloom-hair/manage/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
  expect(missing.status()).toBe(404);
});

// Add-ons (design §11): the salon gets rackets to rent and a treatment that adds 30 minutes, set up
// straight in the test database for this test only (the other tests expect no add-on step).
test("add-ons: after the time the customer picks extras, the price adds up, and the booking keeps them", async ({ page }) => {
  const { Client } = require("pg");
  const db = new Client({ connectionString: process.env.BOOKING_DB_URL || "postgres://postgres@127.0.0.1:54329/booking_test" });
  await db.connect();
  const SALON = "b1000000-0000-4000-8000-000000000001";
  const CUT = "c1000000-0000-4000-8000-000000000001";
  const rackets = "f0e00000-0000-4000-8000-000000000001";
  const groups = ["f1e00000-0000-4000-8000-000000000001", "f1e00000-0000-4000-8000-000000000002"];
  try {
    await db.query("insert into public.resources (id, business_id, kind, name, capacity) values ($1, $2, 'ไม้แบด', 'ไม้แบด', 3)", [rackets, SALON]);
    await db.query("insert into public.addon_groups (id, business_id, name, sort_order) values ($1, $3, 'อุปกรณ์', 1), ($2, $3, 'บริการเสริม', 2)", [...groups, SALON]);
    await db.query("update public.addon_groups set max_select = 1 where id = $1", [groups[1]]);
    await db.query(
      `insert into public.addons (business_id, group_id, name, price_unit, amount, max_quantity, adds_minutes, uses_kind, sort_order) values
         ($1, $2, 'เช่าไม้', 'per_unit', 50, 4, 0, 'ไม้แบด', 1),
         ($1, $3, 'ทรีตเมนต์เพิ่ม', 'per_booking', 300, 1, 30, null, 1)`,
      [SALON, ...groups]
    );
    await db.query("insert into public.offering_addon_groups (business_id, offering_id, group_id) select $1, $2, unnest($3::uuid[])", [SALON, CUT, groups]);

    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto("/b/bloom-hair");
    await page.getByRole("button", { name: /เลือกบริการก่อน/ }).click();
    await page.locator('[data-testid="option-offering"]', { hasText: "ตัดผมหญิง" }).click();
    await page.getByRole("button", { name: "ช่างแนน" }).click();
    await enabled(page, "date").nth(6).click();
    await enabled(page, "time").first().click();

    await expect(page.getByRole("heading", { name: "ตัวเลือกเพิ่มเติม" })).toBeVisible();
    await page.getByRole("checkbox", { name: /เช่าไม้/ }).click();
    await page.getByRole("button", { name: "เพิ่มจำนวน" }).click();
    await page.getByRole("radio", { name: /ทรีตเมนต์เพิ่ม/ }).click();
    await page.getByRole("button", { name: /ต่อไป · เพิ่ม 2 อย่าง/ }).click();

    await expect(page.getByRole("button", { name: /ยืนยันการจอง · 850 บาท/ })).toBeVisible(); // 450 + 2 × 50 + 300
    await fillAndConfirm(page, "ลูกค้าเช่าไม้");
    const done = page.getByTestId("booking-done");
    await expect(done).toContainText("จองสำเร็จ");
    await expect(done).toContainText("เช่าไม้ ×2, ทรีตเมนต์เพิ่ม");
    await expect(done).toContainText("850 บาท");
    await expect(done).not.toContainText("ไม้แบด"); // the rackets are not shown as the stylist
    expect(errors).toEqual([]);
  } finally {
    await db.query("delete from public.booking_addons where addon_id in (select id from public.addons where group_id = any($1::uuid[]))", [groups]);
    await db.query("delete from public.booking_resources where resource_id = $1", [rackets]);
    await db.query("delete from public.addon_groups where id = any($1::uuid[])", [groups]);
    await db.query("delete from public.resources where id = $1", [rackets]);
    await db.end();
  }
});
