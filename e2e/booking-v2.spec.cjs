// The customer booking page (docs/DESIGN_BOOKING_V3.md) against the demo shops in supabase/seed.sql.
// Needs the app running with BOOKING_DB_URL pointing at a database built by scripts/db-test.sh:
//   BOOKING_DB_URL=postgres://… BOOKING_BOOK_LIMIT=100 npx next dev -p 3100
//   PILOT_BASE_URL=http://127.0.0.1:3100 npx playwright test e2e/booking-v2.spec.cjs
// Dates and times are picked from what the page offers, so the tests do not depend on the day.
const { test, expect } = require("@playwright/test");

test.use({ viewport: { width: 390, height: 844 } });

const enabled = (page, step) => page.locator(`[data-testid="option-${step}"]:not([disabled])`);
const option = (page, step, text) => page.getByTestId(`option-${step}`).filter({ hasText: text });

// The customer flow (docs/DESIGN_BOOKING_V3.md): service → stylist / court → day → day and time → the
// customer's details → booked. Every shop starts from the service now.
async function start(page, slug = "bloom-hair") {
  await page.goto(`/b/${slug}`);
  await expect(page.getByRole("heading", { name: "เลือกบริการ" })).toBeVisible();
}

async function fillAndConfirm(page, name) {
  await expect(page.getByRole("heading", { name: "ข้อมูลผู้รับบริการ" })).toBeVisible();
  await page.getByLabel(/ชื่อ-นามสกุล/).fill(name);
  await page.getByLabel(/เบอร์โทรศัพท์/).fill("0812345678");
  await page.getByRole("button", { name: /^ยืนยันการจอง/ }).click();
}

// a day, then its first free time (both on the "day and time" step)
async function pickDayAndTime(page, day, time = 0) {
  await expect(page.getByRole("heading", { name: "เลือกวัน", exact: true })).toBeVisible();
  await enabled(page, "date").nth(day).click();
  await expect(page.getByRole("heading", { name: "เลือกวันและเวลา" })).toBeVisible();
  const slot = time === "last" ? enabled(page, "time").last() : enabled(page, "time").nth(time);
  await slot.click();
}

test("salon: a cut, anyone, then the day and a time on one step", async ({ page }) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await start(page);
  await expect(page.getByRole("heading", { name: "เริ่มจองจาก" })).toHaveCount(0);
  await option(page, "offering", "ตัดผมหญิง").click();

  await expect(page.getByRole("heading", { name: "เลือกช่าง" })).toBeVisible();
  // ช่างพลอย does colour only, so she is not offered for a cut
  await expect(page.getByTestId("option-resource")).not.toContainText(["ช่างพลอย"]);
  await option(page, "resource", "ช่างคนไหนก็ได้").click();

  await expect(page.getByRole("heading", { name: "เลือกวัน", exact: true })).toBeVisible();
  await expect(page.getByTestId("option-date").first()).toContainText(/วันนี้|จ\.|อ\.|พ\.|พฤ\.|ศ\.|ส\.|อา\./);
  await enabled(page, "date").nth(2).click();
  // the times come in parts of the day, with the days still there to change
  await expect(page.getByRole("heading", { name: "เลือกวันและเวลา" })).toBeVisible();
  await expect(page.getByRole("heading", { name: /ช่วง(เช้า|บ่าย|เย็น)/ }).first()).toBeVisible();
  await expect(page.getByTestId("option-date").first()).toBeVisible();
  await enabled(page, "time").first().click();

  await fillAndConfirm(page, "ลูกค้าเลือกตัดผม");
  const done = page.getByTestId("booking-done");
  await expect(done).toContainText("จองคิวสำเร็จ");
  await expect(done).toContainText("450 บาท");
  await expect(done).toContainText(/ช่าง(แนน|บี)/);
  expect(errors).toEqual([]);
});

test("date step: the month calendar shows the same days, picks one, and is remembered on this phone", async ({ page }) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const toDays = async () => {
    await start(page);
    await option(page, "offering", "ตัดผมหญิง").click();
    await option(page, "resource", "ช่างคนไหนก็ได้").click();
    await expect(page.getByRole("heading", { name: "เลือกวัน", exact: true })).toBeVisible();
  };
  await toDays();
  await page.getByRole("button", { name: /ปฏิทิน/ }).click();

  const calendar = page.locator(".bk-calendar");
  await expect(calendar.getByRole("columnheader")).toHaveCount(7);
  await expect(page.getByRole("button", { name: "เดือนก่อนหน้า" })).toBeDisabled();
  // the strip's days are the calendar's buttons; nothing before today can be tapped
  const days = calendar.locator('[data-testid="option-date"]:not([disabled])');
  expect(await days.count()).toBeGreaterThan(5);
  const value = await days.nth(3).getAttribute("data-value");
  await days.nth(3).click();
  await expect(page.getByRole("heading", { name: "เลือกวันและเวลา" })).toBeVisible();
  await expect(page.locator(".bk-chips")).toContainText(String(Number(value.slice(8))));

  // back on the date step later: the calendar again
  await toDays();
  await expect(page.locator(".bk-calendar")).toBeVisible();
  await page.getByRole("button", { name: /แถบวัน/ }).click();
  await expect(page.locator(".bk-date-strip").first()).toBeVisible();
  expect(errors).toEqual([]);
});

test("salon: colour with the colourist, then the day and time", async ({ page }) => {
  await start(page);
  await option(page, "offering", "ทำสีผม").click();
  await option(page, "resource", "ช่างพลอย").click();
  await pickDayAndTime(page, 3);
  await fillAndConfirm(page, "ลูกค้าทำสี");
  const done = page.getByTestId("booking-done");
  await expect(done).toContainText("จองคิวสำเร็จ");
  await expect(done).toContainText("ช่างพลอย");
  await expect(done).toContainText("1,500 บาท");
});

test("salon: going back to change the service drops a stylist who does not do it", async ({ page }) => {
  await start(page);
  await option(page, "offering", "ทำสีผม").click();
  await option(page, "resource", "ช่างพลอย").click();
  await expect(page.getByRole("heading", { name: "เลือกวัน", exact: true })).toBeVisible();

  // tap the service chip and switch to a cut
  await page.getByRole("button", { name: /ทำสีผม\s*เปลี่ยน/ }).click();
  await option(page, "offering", "ตัดผมหญิง").click();
  await expect(page.getByRole("status")).toContainText("ช่างพลอย (ทำสีเท่านั้น) ไม่มีบริการนี้");
  await expect(page.getByRole("heading", { name: "เลือกช่าง" })).toBeVisible();
  await expect(page.getByRole("button", { name: /ตัดผมหญิง.*เปลี่ยน/ })).toBeVisible();
});

test("barber: no barber to pick; Mondays are greyed out as closed", async ({ page }) => {
  await start(page, "gentleman-barber");
  await option(page, "offering", "ตัดผมชาย").click();
  await expect(page.getByRole("heading", { name: "เลือกวัน", exact: true })).toBeVisible();
  await expect(page.locator('[data-testid="option-date"][disabled]').filter({ hasText: "ร้านปิด" }).first()).toBeVisible();
  await enabled(page, "date").nth(1).click();
  // the shop assigns a barber
  await expect(page.getByRole("heading", { name: "เลือกวันและเวลา" })).toBeVisible();
  await enabled(page, "time").first().click();
  await fillAndConfirm(page, "ลูกค้าร้านตัดผม");
  const done = page.getByTestId("booking-done");
  await expect(done).toContainText("จองคิวสำเร็จ");
  await expect(done).toContainText(/ช่าง(โต้ง|เอก)/);
});

test("two customers on one slot: the second is told it was just taken and picks again", async ({ browser }) => {
  const a = await browser.newPage();
  const b = await browser.newPage();
  for (const page of [a, b]) {
    await start(page);
    await option(page, "offering", "ทรีตเมนต์").click();
    await option(page, "resource", "ช่างแนน").click();
    await pickDayAndTime(page, 5);
  }
  await fillAndConfirm(a, "ลูกค้า A");
  await expect(a.getByTestId("booking-done")).toContainText("จองคิวสำเร็จ");

  await b.getByLabel(/ชื่อ-นามสกุล/).fill("ลูกค้า B");
  await b.getByLabel(/เบอร์โทรศัพท์/).fill("0812345678");
  await b.getByRole("button", { name: /^ยืนยันการจอง/ }).click();
  await expect(b.getByRole("status")).toContainText("เพิ่งถูกจอง");
  await expect(b.getByRole("heading", { name: "เลือกวันและเวลา" })).toBeVisible();
  await enabled(b, "time").first().click();
  await fillAndConfirm(b, "ลูกค้า B");
  await expect(b.getByTestId("booking-done")).toContainText("จองคิวสำเร็จ");
});

test("the customer opens their link, moves the booking, then cancels it", async ({ page }) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await start(page);
  await option(page, "offering", "ทรีตเมนต์").click();
  await option(page, "resource", "ช่างบี").click();
  await pickDayAndTime(page, 4);
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
    await start(page);
    await option(page, "offering", "ตัดผมหญิง").click();
    await option(page, "resource", "ช่างแนน").click();
    await pickDayAndTime(page, 6);

    await expect(page.getByRole("heading", { name: "ตัวเลือกเพิ่มเติม" })).toBeVisible();
    await page.getByRole("checkbox", { name: /เช่าไม้/ }).click();
    await page.getByRole("button", { name: "เพิ่มจำนวน" }).click();
    await page.getByRole("radio", { name: /ทรีตเมนต์เพิ่ม/ }).click();
    await page.getByRole("button", { name: /ต่อไป · เพิ่ม 2 อย่าง/ }).click();

    await expect(page.getByRole("button", { name: /ยืนยันการจอง · 850 บาท/ })).toBeVisible(); // 450 + 2 × 50 + 300
    await fillAndConfirm(page, "ลูกค้าเช่าไม้");
    const done = page.getByTestId("booking-done");
    await expect(done).toContainText("จองคิวสำเร็จ");
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

// Transfer deposit (migration …002200): the salon asks for 200 baht; the customer books, sees where to
// transfer, sends a slip, and the booking waits for the shop. Settings are put back afterwards.
test("deposit: the booking is held, the customer sees the account and sends a slip, then waits for the shop", async ({ page }) => {
  const { Client } = require("pg");
  const sharp = require("sharp");
  const db = new Client({ connectionString: process.env.BOOKING_DB_URL || "postgres://postgres@127.0.0.1:54329/booking_test" });
  await db.connect();
  const SALON = "b1000000-0000-4000-8000-000000000001";
  const { rows: [before] } = await db.query("select deposit_mode, deposit_value, payment_info, hold_minutes from public.business_booking_settings where business_id = $1", [SALON]);
  try {
    await db.query(
      `update public.business_booking_settings set deposit_mode = 'fixed', deposit_value = 200, hold_minutes = 60,
              payment_info = '{"bank":"กสิกรไทย","accountNumber":"123-4-56789-0","accountName":"บลูม แฮร์"}' where business_id = $1`,
      [SALON]
    );
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await start(page);
    await option(page, "offering", "ทรีตเมนต์").click();
    await option(page, "resource", "ช่างบี").click();
    await pickDayAndTime(page, 7, "last");
    await expect(page.getByText(/ร้านนี้ขอมัดจำ\s*200 บาท/)).toBeVisible();
    await fillAndConfirm(page, "ลูกค้ามัดจำ");

    const done = page.getByTestId("booking-done");
    await expect(done).toContainText("กันคิวไว้ให้แล้ว");
    await expect(done).toContainText("โอนมัดจำเพื่อยืนยันคิว");
    await expect(done).toContainText("123-4-56789-0");
    const slip = await sharp({ create: { width: 300, height: 500, channels: 3, background: "#e8f5e9" } }).png().toBuffer();
    await done.locator('input[type="file"]').setInputFiles({ name: "slip.png", mimeType: "image/png", buffer: slip });
    await expect(done).toContainText("ส่งสลิปแล้ว รอร้านยืนยัน");
    await expect(done).toContainText("ส่งสลิปแล้ว 1 รูป");

    await page.getByTestId("manage-link").click();
    await page.waitForLoadState("networkidle");
    await expect(page.getByTestId("manage-booking")).toContainText("รอร้านตรวจสลิป");
    await expect(page.getByText("ส่งสลิปแล้ว รอร้านตรวจ")).toBeVisible();
    expect(errors).toEqual([]);
  } finally {
    await db.query(
      "update public.business_booking_settings set deposit_mode = $2, deposit_value = $3, payment_info = $4, hold_minutes = $5 where business_id = $1",
      [SALON, before.deposit_mode, before.deposit_value, before.payment_info, before.hold_minutes]
    );
    await db.end();
  }
});

test("rental by the day: pick-up day, how many days, pick-up time; back the same time days later", async ({ page }) => {
  const { Client } = require("pg");
  const db = new Client({ connectionString: process.env.BOOKING_DB_URL || "postgres://postgres@127.0.0.1:54329/booking_test" });
  await db.connect();
  const BARBER = "b2000000-0000-4000-8000-000000000002"; // open 09–19, closed Mondays
  const { rows: [car] } = await db.query("insert into public.resources (business_id, kind, name, capacity) values ($1, 'รถ', 'Yaris ทดสอบ', 1) returning id", [BARBER]);
  const { rows: [hire] } = await db.query(
    "insert into public.offerings (business_id, name, duration_mode, min_days, max_days, sort_order) values ($1, 'เช่ารถรายวัน', 'days', 1, 3, 99) returning id",
    [BARBER]
  );
  await db.query("insert into public.offering_requirements (business_id, offering_id, kind, customer_picks, units_per_booking) values ($1, $2, 'รถ', false, 'one')", [BARBER, hire.id]);
  await db.query("insert into public.offering_resources (business_id, offering_id, resource_id) values ($1, $2, $3)", [BARBER, hire.id, car.id]);
  await db.query("insert into public.price_rules (business_id, offering_id, unit, amount) values ($1, $2, 'per_day', 1000)", [BARBER, hire.id]);
  try {
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await start(page, "gentleman-barber");
    await option(page, "offering", "เช่ารถรายวัน").click();
    await expect(page.getByRole("heading", { name: "เลือกวันรับ" })).toBeVisible();
    await enabled(page, "date").nth(1).click();
    await expect(page.getByRole("heading", { name: "เช่ากี่วัน" })).toBeVisible();
    await expect(page.locator('[data-testid="option-duration"]').first()).toContainText(/1 วัน\s*คืน/);
    await enabled(page, "duration").last().click();
    // the pick-up time with the pick-up days still there; back the same time
    await expect(page.getByRole("heading", { name: "เลือกวันและเวลา" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "เลือกวันรับ" })).toBeVisible();
    await expect(page.getByText(/เลือกเวลาที่สะดวกรับ · คืนเวลาเดียวกัน/)).toBeVisible();
    await enabled(page, "time").first().click();
    await expect(page.getByText(/ราคารวม/)).toBeVisible();
    await fillAndConfirm(page, "ผู้เช่ารถ");
    const done = page.getByTestId("booking-done");
    await expect(done).toContainText("จองคิวสำเร็จ");
    await expect(done).toContainText(/รับ \d\d:\d\d น\. · คืน .+ \d\d:\d\d น\./);
    expect(errors).toEqual([]);
  } finally {
    await db.query("delete from public.bookings where offering_id = $1", [hire.id]);
    await db.query("delete from public.offerings where id = $1", [hire.id]);
    await db.query("delete from public.resources where id = $1", [car.id]);
    await db.end();
  }
});

// LINE on Android enlarges every font by its own setting (WebView text zoom); app/b/text-zoom.mjs measures
// it against a canvas and lowers the root font size to match. Here the canvas is made to read 1.3× narrower,
// as it would against zoomed page text.
test("inside LINE, the app's own text zoom is undone; in a browser the page is left alone", async ({ browser }) => {
  const line = await browser.newContext({ viewport: { width: 390, height: 844 }, userAgent: "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/126 Mobile Safari/537.36 Line/14.20.0" });
  const zoomed = await line.newPage();
  await zoomed.addInitScript(() => {
    const measure = CanvasRenderingContext2D.prototype.measureText;
    CanvasRenderingContext2D.prototype.measureText = function (text) {
      const m = measure.call(this, text);
      return { width: m.width / 1.3 };
    };
  });
  await zoomed.goto("/b/bloom-hair");
  const root = await zoomed.evaluate(() => [getComputedStyle(document.documentElement).fontSize, document.documentElement.dataset.textZoom]);
  expect(Math.abs(parseFloat(root[0]) - 16 / 1.3)).toBeLessThan(0.01);
  expect(root[1]).toBe("1.30");
  await line.close();

  const plain = await browser.newPage();
  await plain.goto("/b/bloom-hair");
  expect(await plain.evaluate(() => [getComputedStyle(document.documentElement).fontSize, document.documentElement.dataset.textZoom ?? null])).toEqual(["16px", null]);
  await plain.close();
});
