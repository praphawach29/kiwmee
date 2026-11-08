// The customer booking page (docs/DESIGN_BOOKING_V3.md) against the demo shops in supabase/seed.sql.
// Needs the app running with BOOKING_DB_URL pointing at a database built by scripts/db-test.sh:
//   BOOKING_DB_URL=postgres://… BOOKING_BOOK_LIMIT=100 NEXT_PUBLIC_LIFF_ID=1234567890-AbCdEfGh npx next dev -p 3100
//   NEXT_PUBLIC_LIFF_ID=1234567890-AbCdEfGh PILOT_BASE_URL=http://127.0.0.1:3100 npx playwright test e2e/booking-v2.spec.cjs
// Dates and times are picked from what the page offers, so the tests do not depend on the day.
const { test, expect } = require("@playwright/test");

test.use({ viewport: { width: 390, height: 844 } });

// LINE (LIFF): CI runs the app with a LIFF ID, so every page loads LINE's SDK. The tests never reach
// LINE: the SDK is replaced by a stand-in — by default "a browser, not signed in to LINE"; the LINE
// member test swaps in "inside LINE, signed in". What the server would say about the member is stubbed
// too (the server checks the token with LINE; supabase/tests/my-bookings.test.js covers that part).
const LINE_SDK = "https://static.line-scdn.net/**";
const fakeLine = (inLine) => `window.liff = {
  init: async () => {}, isInClient: () => ${inLine}, isLoggedIn: () => ${inLine},
  login: () => { window.__lineLogin = true; }, getIDToken: () => ${inLine ? '"e2e-token"' : "null"},
  getProfile: async () => ({ displayName: "Malee", pictureUrl: null })
};`;
const noLine = (target) => target.route(LINE_SDK, (r) => r.fulfill({ contentType: "text/javascript", body: fakeLine(false) }));
test.beforeEach(async ({ context }) => noLine(context));

const enabled = (page, step) => page.locator(`[data-testid="option-${step}"]:not([disabled])`);
const option = (page, step, text) => page.getByTestId(`option-${step}`).filter({ hasText: text });

// The customer flow (docs/DESIGN_BOOKING_V3.md + design "Kiwmee ปรับหน้าตา"): service → one screen with
// the stylist (anyone, picked for them), the day (the first free one, picked for them) and the time →
// the customer's details → booked. Every shop starts from the service now.
async function start(page, slug = "bloom-hair") {
  await page.goto(`/b/${slug}`);
  await expect(page.getByRole("heading", { name: "เลือกบริการ" })).toBeVisible();
}

const idle = (page) => expect(page.locator("main.bk-shell")).toHaveAttribute("aria-busy", "false");

// a service, then (optionally) a stylist by name on the day-and-time screen
async function service(page, text, staff = null) {
  await option(page, "offering", text).click();
  await expect(page.getByRole("heading", { name: "เลือกวันและเวลา" })).toBeVisible();
  await expect(enabled(page, "time").first()).toBeVisible(); // the first free day is already picked
  if (staff) {
    await option(page, "resource", staff).click();
    await expect(option(page, "resource", staff)).toHaveAttribute("data-selected", "true");
    await idle(page);
  }
}

async function fillAndConfirm(page, name, note = null) {
  await expect(page.getByRole("heading", { name: "ข้อมูลผู้รับบริการ" })).toBeVisible();
  await page.getByLabel(/ชื่อ-นามสกุล/).fill(name);
  await page.getByLabel(/เบอร์โทรศัพท์/).fill("0812345678");
  if (note) await page.getByLabel(/ฝากถึงร้าน/).fill(note);
  await page.getByRole("button", { name: /^ยืนยันการจอง/ }).click();
}

// a day from the strip, then one of its free times (all on the "day and time" screen)
async function pickDayAndTime(page, day, time = 0) {
  await expect(page.getByRole("heading", { name: "เลือกวันและเวลา" })).toBeVisible();
  await idle(page);
  const date = enabled(page, "date").nth(day);
  const value = await date.getAttribute("data-value");
  await date.click();
  await expect(page.locator(`[data-testid="option-date"][data-value="${value}"]`).first()).toHaveAttribute("data-selected", "true");
  await idle(page);
  const slot = time === "last" ? enabled(page, "time").last() : enabled(page, "time").nth(time);
  await slot.click();
}

test("salon: a cut, then anyone, the day and a time on one screen", async ({ page }) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await start(page);
  await expect(page.getByRole("heading", { name: "เริ่มจองจาก" })).toHaveCount(0);
  // the header says whether the shop is open today; a slim progress line says what comes next
  await expect(page.locator(".bk-shop-today")).toHaveText(/เปิดวันนี้|เปิดอยู่|ปิดแล้ว|ร้านปิด/);
  await expect(page.locator(".bk-progress-meta")).toContainText("ต่อไป: วันและเวลา");
  await expect(page.locator(".bk-storefront-banner")).toHaveCount(0);
  await service(page, "ตัดผมหญิง");

  // one screen: the stylists as a row ("anyone" picked), the days (the first free one picked), the times
  await expect(option(page, "resource", "ใครก็ได้")).toHaveAttribute("data-selected", "true");
  // ช่างพลอย does colour only, so she is not offered for a cut
  await expect(page.getByTestId("option-resource")).not.toContainText(["ช่างพลอย"]);
  await expect(page.locator('[data-testid="option-date"][data-selected="true"]')).toHaveCount(1);
  await expect(page.getByTestId("option-date").first()).toContainText(/วันนี้|จ\.|อ\.|พ\.|พฤ\.|ศ\.|ส\.|อา\./);
  await expect(page.getByRole("heading", { name: /ช่วง(เช้า|บ่าย|เย็น)/ }).first()).toBeVisible();
  await expect(page.locator(".bk-progress-meta")).toContainText("ต่อไป: ข้อมูลผู้จอง");
  // the bar at the bottom keeps what is picked and the price
  const bar = page.getByTestId("pick-bar");
  await expect(bar).toContainText("ตัดผมหญิง + สระไดร์");
  await expect(bar).toContainText("450 บาท");
  // back to the services: the cut is ticked, and the bar goes on to the times
  await page.locator(".bk-flow-back").click();
  await expect(option(page, "offering", "ตัดผมหญิง")).toHaveAttribute("data-selected", "true");
  await bar.getByRole("button", { name: /ต่อไป/ }).click();
  await expect(page.getByRole("heading", { name: "เลือกวันและเวลา" })).toBeVisible();
  await pickDayAndTime(page, 2);

  // the confirm step (design Confirm): what is booked on top, one way back to change it, then the form
  await expect(page.getByRole("heading", { name: "ข้อมูลผู้รับบริการ" })).toBeVisible();
  const summary = page.getByTestId("confirm-summary");
  await expect(summary).toContainText("ตัดผมหญิง + สระไดร์");
  await expect(summary).toContainText("450 บาท · จ่ายที่ร้าน");
  await summary.getByRole("button", { name: "แก้ไข" }).click();
  await expect(page.getByRole("heading", { name: "เลือกวันและเวลา" })).toBeVisible();
  await idle(page);
  await enabled(page, "time").first().click();
  await fillAndConfirm(page, "ลูกค้าเลือกตัดผม", "ขอสระด้วยน้ำอุ่น");
  const done = page.getByTestId("booking-done");
  await expect(done).toContainText("จองคิวสำเร็จ");
  await expect(done).toContainText("450 บาท");
  // one stylist line: who the shop gave, not "anyone" as well
  await expect(done.locator(".bk-done-summary dt", { hasText: "ช่าง" })).toHaveCount(1);
  await expect(done.locator(".bk-done-summary")).toContainText(/ช่าง(แนน|บี)\s*ระบบเลือกให้/);
  await expect(done.locator(".bk-done-summary")).not.toContainText("ช่างคนไหนก็ได้");
  // the design's done screen: who the shop waits for, the next things to do, the QR, book again
  await expect(done).toContainText("รอพบคุณลูกค้าเลือกตัดผม");
  await expect(done.getByRole("button", { name: "เพิ่มลงปฏิทิน" })).toBeVisible();
  await expect(done.locator(".bk-done-qr")).toBeVisible();
  await expect(done.getByRole("link", { name: "จองคิวอีกครั้ง" })).toHaveAttribute("href", "/b/bloom-hair");
  // "ฝากถึงร้าน" is kept with the booking for the shop
  const { Client } = require("pg");
  const db = new Client({ connectionString: process.env.BOOKING_DB_URL || "postgres://postgres@127.0.0.1:54329/booking_test" });
  await db.connect();
  try {
    const { rows: [kept] } = await db.query("select customer_note from public.bookings where customer_name = 'ลูกค้าเลือกตัดผม' order by created_at desc limit 1");
    expect(kept.customer_note).toBe("ขอสระด้วยน้ำอุ่น");
  } finally {
    await db.end();
  }
  expect(errors).toEqual([]);
});

test("date step: the month calendar shows the same days, picks one, and is remembered on this phone", async ({ page }) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const toDays = async () => {
    await start(page);
    await service(page, "ตัดผมหญิง");
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
  await expect(page.locator(`[data-testid="option-date"][data-value="${value}"]`)).toHaveAttribute("data-selected", "true");

  // back on the date step later: the calendar again
  await toDays();
  await expect(page.locator(".bk-calendar")).toBeVisible();
  await page.getByRole("button", { name: /แถบวัน/ }).click();
  await expect(page.locator(".bk-date-strip").first()).toBeVisible();
  expect(errors).toEqual([]);
});

test("salon: colour with the colourist, then the day and time", async ({ page }) => {
  await start(page);
  await service(page, "ทำสีผม", "ช่างพลอย");
  await pickDayAndTime(page, 3);
  await fillAndConfirm(page, "ลูกค้าทำสี");
  const done = page.getByTestId("booking-done");
  await expect(done).toContainText("จองคิวสำเร็จ");
  await expect(done).toContainText("ช่างพลอย");
  await expect(done).toContainText("1,500 บาท");
  // picked by name: shown once, without "the system picked"
  await expect(done.locator(".bk-done-summary dt", { hasText: "ช่าง" })).toHaveCount(1);
  await expect(done).not.toContainText("ระบบเลือกให้");
});

test("salon: going back to change the service drops a stylist who does not do it", async ({ page }) => {
  await start(page);
  await service(page, "ทำสีผม", "ช่างพลอย");

  // tap the service chip and switch to a cut: she is dropped (and said so), anyone is picked instead
  await page.getByRole("button", { name: /ทำสีผม\s*เปลี่ยน/ }).click();
  await option(page, "offering", "ตัดผมหญิง").click();
  await expect(page.getByRole("status")).toContainText("ช่างพลอย (ทำสีเท่านั้น) ไม่มีบริการนี้");
  await expect(page.getByRole("heading", { name: "เลือกวันและเวลา" })).toBeVisible();
  await expect(option(page, "resource", "ใครก็ได้")).toHaveAttribute("data-selected", "true");
  await expect(page.getByTestId("option-resource")).not.toContainText(["ช่างพลอย"]);
  await expect(page.getByRole("button", { name: /ตัดผมหญิง.*เปลี่ยน/ })).toBeVisible();
});

test("barber: no barber to pick; Mondays are greyed out as closed", async ({ page }) => {
  await start(page, "gentleman-barber");
  await service(page, "ตัดผมชาย");
  // the shop assigns a barber: no row of barbers
  await expect(page.getByTestId("option-resource")).toHaveCount(0);
  await expect(page.locator('[data-testid="option-date"][disabled]').filter({ hasText: "ร้านปิด" }).first()).toBeVisible();
  await pickDayAndTime(page, 1);
  await fillAndConfirm(page, "ลูกค้าร้านตัดผม");
  const done = page.getByTestId("booking-done");
  await expect(done).toContainText("จองคิวสำเร็จ");
  await expect(done).toContainText(/ช่าง(โต้ง|เอก)/);
});

test("two customers on one slot: the second is told it was just taken and picks again", async ({ browser }) => {
  const a = await browser.newPage();
  const b = await browser.newPage();
  await noLine(a);
  await noLine(b);
  for (const page of [a, b]) {
    await start(page);
    await service(page, "ทรีตเมนต์", "ช่างแนน");
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
  await service(page, "ทรีตเมนต์", "ช่างบี");
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
    await service(page, "ตัดผมหญิง", "ช่างแนน");
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
    await service(page, "ทรีตเมนต์", "ช่างบี");
    await pickDayAndTime(page, 7, "last");
    // the customer may pay the deposit (picked) or the whole price
    const choice = page.getByTestId("pay-choice");
    await expect(choice.getByRole("radio", { name: /มัดจำ 200 บาท/ })).toHaveAttribute("aria-checked", "true");
    await expect(choice.getByRole("radio", { name: /จ่ายเต็มจำนวน/ })).toHaveAttribute("aria-checked", "false");
    // the bar: the whole price, and the deposit paid now
    await expect(page.locator(".bk-submit-sum")).toContainText("ราคารวม");
    await expect(page.locator(".bk-submit-now")).toContainText("มัดจำตอนนี้200 บาท");
    await fillAndConfirm(page, "ลูกค้ามัดจำ");

    const done = page.getByTestId("booking-done");
    await expect(done).toContainText("กันคิวไว้ให้แล้ว");
    // no check-in QR while the deposit is awaited
    await expect(done.getByText("QR เช็กอินจะแสดงเมื่อร้านยืนยันมัดจำแล้ว")).toBeVisible();
    await expect(done.locator(".bk-done-qr")).toHaveCount(0);
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
    await expect(page.getByText("QR เช็กอินจะแสดงเมื่อร้านยืนยันมัดจำแล้ว")).toBeVisible();
    expect(errors).toEqual([]);
  } finally {
    await db.query(
      "update public.business_booking_settings set deposit_mode = $2, deposit_value = $3, payment_info = $4, hold_minutes = $5 where business_id = $1",
      [SALON, before.deposit_mode, before.deposit_value, before.payment_info, before.hold_minutes]
    );
    await db.end();
  }
});

// The customer chooses to pay in full (migration …003800): the QR and the box ask for the whole price.
test("deposit: the customer picks paying in full, and is asked for the whole price", async ({ page }) => {
  const { Client } = require("pg");
  const db = new Client({ connectionString: process.env.BOOKING_DB_URL || "postgres://postgres@127.0.0.1:54329/booking_test" });
  await db.connect();
  const SALON = "b1000000-0000-4000-8000-000000000001";
  const { rows: [before] } = await db.query("select deposit_mode, deposit_value, payment_info, hold_minutes from public.business_booking_settings where business_id = $1", [SALON]);
  try {
    await db.query(
      `update public.business_booking_settings set deposit_mode = 'fixed', deposit_value = 200, hold_minutes = 60, deposit_allow_full = true,
              payment_info = '{"bank":"กสิกรไทย","accountNumber":"123-4-56789-0","accountName":"บลูม แฮร์"}' where business_id = $1`,
      [SALON]
    );
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await start(page);
    await service(page, "ทรีตเมนต์", "ช่างบี");
    await pickDayAndTime(page, 6, "last");
    const choice = page.getByTestId("pay-choice");
    const full = choice.getByRole("radio", { name: /จ่ายเต็มจำนวน/ });
    const amount = (await full.innerText()).match(/จ่ายเต็มจำนวน\s*([\d,]+) บาท/)[1];
    await full.click();
    await expect(full).toHaveAttribute("aria-checked", "true");
    await expect(page.locator(".bk-submit-bar")).toContainText("ยืนยันและดู QR ชำระเงิน");
    await expect(page.locator(".bk-submit-bar")).toContainText(`จ่ายเต็มตอนนี้${amount} บาท`);
    await fillAndConfirm(page, "ลูกค้าจ่ายเต็ม");

    const done = page.getByTestId("booking-done");
    await expect(done).toContainText("กันคิวไว้ให้แล้ว");
    await expect(done).toContainText("โอนชำระเต็มจำนวนเพื่อยืนยันคิว");
    await expect(done.locator(".bk-deposit-amount")).toContainText(amount);
    const { rows: [b] } = await db.query("select deposit_due::float8 as due, (price_snapshot->>'total')::float8 as total from public.bookings where customer_name = 'ลูกค้าจ่ายเต็ม' order by created_at desc limit 1");
    expect(b.due).toBe(b.total);
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
  await noLine(line);
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
  await noLine(plain);
  await plain.goto("/b/bloom-hair");
  expect(await plain.evaluate(() => [getComputedStyle(document.documentElement).fontSize, document.documentElement.dataset.textZoom ?? null])).toEqual(["16px", null]);
  await plain.close();
});

// A LINE member (design "Kiwmee ปรับหน้าตา"): welcomed by name with points and the next booking, one tap
// to book last time's service with the same stylist, and the form already filled from last time.
test("LINE member: welcome card, book again with the same stylist, the form filled from last time", async ({ page, context }) => {
  test.skip(!process.env.NEXT_PUBLIC_LIFF_ID, "start the app (and the tests) with NEXT_PUBLIC_LIFF_ID");
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await context.unroute(LINE_SDK);
  await context.route(LINE_SDK, (r) => r.fulfill({ contentType: "text/javascript", body: fakeLine(true) }));
  await page.route("**/me/rewards", (r) => r.fulfill({ contentType: "application/json", body: JSON.stringify({ data: null }) }));
  await page.route("**/me/welcome", (r) => r.fulfill({ contentType: "application/json", body: JSON.stringify({ data: {
    customer: { name: "มาลี ใจดี", phone: "0899998888", visits: 3 },
    points: { name: "Bloom Club", balance: 1250, tier: { name: "Gold" }, usable: 2 },
    next: { status: "confirmed", date: "2030-01-15", start: "14:00", offering: "ทรีตเมนต์บำรุงผม", link: "/b/bloom-hair/me" },
    last: { offeringId: "c1000000-0000-4000-8000-000000000001", offering: "ตัดผมหญิง + สระไดร์", resourceId: "a1000000-0000-4000-8000-000000000001", resource: "ช่างแนน" }
  } }) }));

  await start(page);
  const welcome = page.getByTestId("member-welcome");
  await expect(welcome).toContainText("คุณ มาลี ใจดี");
  await expect(welcome).toContainText("มาแล้ว 3 ครั้ง");
  await expect(welcome).toContainText("Gold");
  await expect(welcome).toContainText("1,250");
  await expect(welcome).toContainText("แลกได้ 2 รางวัล");
  await expect(welcome.getByTestId("member-next")).toContainText("14:00 น.");
  await expect(page.getByTestId("member-login")).toHaveCount(0);

  // จองซ้ำ: the cut with ช่างแนน, straight to the day and time
  await welcome.getByTestId("member-rebook").click();
  await expect(page.getByRole("heading", { name: "เลือกวันและเวลา" })).toBeVisible();
  await expect(option(page, "resource", "ช่างแนน")).toHaveAttribute("data-selected", "true");
  await expect(page.getByRole("button", { name: /ตัดผมหญิง.*เปลี่ยน/ })).toBeVisible();
  await idle(page);
  await enabled(page, "time").first().click();

  // the form: last time's name and phone, the phone not required inside LINE
  await expect(page.getByRole("heading", { name: "ข้อมูลผู้รับบริการ" })).toBeVisible();
  await expect(page.getByLabel(/ชื่อ-นามสกุล/)).toHaveValue("มาลี ใจดี");
  await expect(page.getByLabel(/เบอร์โทรศัพท์/)).toHaveValue("0899998888");
  await expect(page.getByLabel(/เบอร์โทรศัพท์/)).not.toHaveAttribute("required", "");
  await expect(page.locator(".bk-line-connected-card")).toContainText("เชื่อมต่อ LINE แล้ว");
  expect(errors).toEqual([]);
});

test("in a browser, a shop with LINE set up offers to sign in with LINE", async ({ page }) => {
  test.skip(!process.env.NEXT_PUBLIC_LIFF_ID, "start the app (and the tests) with NEXT_PUBLIC_LIFF_ID");
  await start(page);
  const login = page.getByTestId("member-login");
  await expect(login).toContainText("เข้าสู่ระบบด้วย LINE");
  await expect(page.getByTestId("member-welcome")).toHaveCount(0);
  await login.getByRole("button", { name: "เข้าสู่ระบบ" }).click();
  expect(await page.evaluate(() => window.__lineLogin)).toBe(true);
});

// A link tapped in a LINE chat opens LINE's in-app browser, not LIFF: LINE's login there says "logged in"
// but never hands the page the session. "เข้าสู่ระบบ" reopens the same page through the LIFF URL instead.
test("inside LINE's in-app browser, signing in reopens the page through LIFF", async ({ browser }) => {
  test.skip(!process.env.NEXT_PUBLIC_LIFF_ID, "start the app (and the tests) with NEXT_PUBLIC_LIFF_ID");
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, userAgent: "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/126 Mobile Safari/537.36 Line/14.20.0" });
  await noLine(context);
  await context.route("https://liff.line.me/**", (r) => r.fulfill({ contentType: "text/html", body: "<title>LIFF</title>" }));
  const page = await context.newPage();
  await start(page);
  await page.getByTestId("member-login").getByRole("button", { name: "เข้าสู่ระบบ" }).click();
  await expect(page).toHaveURL(`https://liff.line.me/${process.env.NEXT_PUBLIC_LIFF_ID}/bloom-hair`);
  expect(await page.evaluate(() => window.__lineLogin)).toBeUndefined();
  await context.close();
});

// Wide screens (design "Kiwmee ปรับหน้าตา" · BookDesktop): the steps in the header, the summary beside
// the page with the way on, the times of day side by side, and no second summary above the form.
test("desktop: steps in the header, the summary beside the page leads on, and edits from the form", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await start(page);
  const steps = page.locator(".bk-header-steps");
  await expect(steps).toBeVisible();
  await expect(steps.locator('[aria-current="step"]')).toContainText("บริการ");
  await expect(page.locator(".bk-progress-wrap")).toBeHidden();

  await service(page, "ตัดผมหญิง");
  await expect(steps.locator('[aria-current="step"]')).toContainText("วันและเวลา");
  const aside = page.getByTestId("summary-aside");
  await expect(aside).toContainText("ตัดผมหญิง + สระไดร์");
  await expect(aside).toContainText("ระยะเวลา");
  await expect(aside).toContainText("450 บาท");
  await expect(page.getByTestId("pick-bar")).toBeHidden();
  // morning, afternoon and evening side by side
  const groups = page.locator(".bk-time-group");
  const [first, second] = [await groups.nth(0).boundingBox(), await groups.nth(1).boundingBox()];
  expect(Math.abs(first.y - second.y)).toBeLessThan(4);
  expect(second.x).toBeGreaterThan(first.x + 100);

  await enabled(page, "time").first().click();
  await expect(page.getByRole("heading", { name: "ข้อมูลผู้รับบริการ" })).toBeVisible();
  await expect(steps.locator('[aria-current="step"]')).toContainText("ข้อมูลผู้จอง");
  await expect(aside).toContainText("วันเวลา");
  await expect(page.getByTestId("confirm-summary")).toBeHidden();
  // back to the times from the summary, then to the services
  await aside.getByRole("button", { name: "แก้ไข" }).click();
  await expect(page.getByRole("heading", { name: "เลือกวันและเวลา" })).toBeVisible();
  await page.locator(".bk-flow-back").click();
  await expect(option(page, "offering", "ตัดผมหญิง")).toHaveAttribute("data-selected", "true");
  // everything is still chosen: the summary leads straight back to the form
  await aside.getByRole("button", { name: "ต่อไป: ข้อมูลผู้จอง" }).click();
  await expect(page.getByRole("heading", { name: "ข้อมูลผู้รับบริการ" })).toBeVisible();
  expect(errors).toEqual([]);
});

test("a shop whose plan takes no online bookings shows the customer a closed notice, not the booking steps", async ({ page }) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const { Client } = require("pg");
  const db = new Client({ connectionString: process.env.BOOKING_DB_URL || "postgres://postgres@127.0.0.1:54329/booking_test" });
  await db.connect();
  const brand = "(select brand_id from public.businesses where slug = 'gentleman-barber')";
  try {
    // the loyalty-only plan has no online booking (migration …004100)
    await db.query(`update public.brand_plans set plan = 'loyalty', valid_until = null where brand_id = ${brand}`);
    await page.goto("/b/gentleman-barber");
    await expect(page.getByRole("heading", { name: "ร้านปิดรับจองออนไลน์ชั่วคราว" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "เลือกบริการ" })).toHaveCount(0);
    await expect(page.locator(".bk-shop-monogram")).toBeVisible(); // the shop is still introduced
  } finally {
    await db.query(`update public.brand_plans set plan = 'pro', valid_until = null where brand_id = ${brand}`);
    await db.end();
  }
  await page.goto("/b/gentleman-barber");
  await expect(page.getByRole("heading", { name: "ร้านปิดรับจองออนไลน์ชั่วคราว" })).toHaveCount(0);
  expect(errors).toEqual([]);
});
