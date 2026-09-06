const { test, expect } = require("@playwright/test");
const fs = require("node:fs");
fs.mkdirSync("artifacts/phase5", { recursive: true });
for (const viewport of [{ width: 390, height: 844 }, { width: 1440, height: 1000 }]) {
  test(`customer AI booking and verified management at ${viewport.width}px`, async ({ page, request }) => {
    await page.setViewportSize(viewport);
    let bookingId; const phone = "0844455555";
    const errors = []; page.on("pageerror", (error) => errors.push(error.message));
    try {
      await page.goto("/assistant");
      await page.getByRole("button", { name: "ดูบริการ", exact: true }).click();
      await page.getByRole("button", { name: /^ตัดผม/ }).click();
      await page.getByRole("button", { name: "ช่างแอน", exact: true }).click();
      await page.getByLabel("วันที่นัด", { exact: true }).fill("2026-09-10");
      await page.getByRole("button", { name: "ตรวจเวลาว่าง" }).click();
      await expect(page.locator(".receptionist-choices button").first()).toBeVisible();
      await page.locator(".receptionist-choices button").first().click();
      await page.getByRole("textbox", { name: "ข้อความ", exact: true }).fill(`มาลี ${phone}`);
      await page.getByRole("button", { name: "ส่งข้อความ" }).click();
      await expect(page.getByRole("heading", { name: "ตรวจสอบนัดหมาย" })).toBeVisible();
      await expect(page.getByRole("heading", { name: "รายการสำเร็จ" })).toHaveCount(0);
      await page.screenshot({ path: `artifacts/phase5/review-${viewport.width}.png`, fullPage: true });
      let release; let seen;
      const intercepted = new Promise((resolve) => { seen = resolve; });
      const hold = new Promise((resolve) => { release = resolve; });
      await page.route("**/api/ai/receptionist", async (route) => {
        if (route.request().postDataJSON().message === "ยืนยัน") { seen(); await hold; }
        await route.continue();
      });
      const confirmed = page.waitForResponse((response) => response.url().endsWith("/api/ai/receptionist") && response.request().postDataJSON().message === "ยืนยัน");
      await page.getByRole("button", { name: "ยืนยัน", exact: true }).click();
      await intercepted;
      await expect(page.getByRole("heading", { name: "รายการสำเร็จ" })).toHaveCount(0);
      release();
      const response = await confirmed; const result = await response.json(); bookingId = result.data.state.booking?.id;
      expect(bookingId).toBeTruthy();
      await expect(page.getByRole("heading", { name: "รายการสำเร็จ" })).toBeVisible();
      await page.screenshot({ path: `artifacts/phase5/success-${viewport.width}.png`, fullPage: true });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      expect((await request.get(`/api/bookings/${bookingId}`)).status()).toBe(403);
      await page.goto(`/manage/${bookingId}`);
      await expect(page.getByRole("button", { name: "ยืนยันข้อมูล" })).toBeVisible();
      await page.getByLabel("เบอร์โทรที่ใช้จอง").fill(phone);
      await page.getByRole("button", { name: "ยืนยันข้อมูล" }).click();
      await expect(page.getByText(bookingId, { exact: true })).toBeVisible();
      expect(errors).toEqual([]);
    } finally {
      if (bookingId) {
        const response = await request.post(`/api/bookings/${bookingId}/cancel`, { headers: { "x-booking-phone": phone }, data: { actor: "customer" } });
        expect(response.ok()).toBeTruthy();
      }
    }
  });
}
test("human handoff, safe HTTP failure and admin login", async ({ page }) => {
  await page.goto("/assistant");
  await page.getByRole("button", { name: "ติดต่อพนักงาน" }).click();
  await expect(page.locator(".receptionist-handoff")).toBeVisible();
  await page.getByRole("button", { name: "เริ่มใหม่", exact: true }).click();
  await page.route("**/api/ai/receptionist", (route) => route.abort());
  await page.getByRole("button", { name: "ดูบริการ", exact: true }).click();
  await expect(page.locator(".receptionist-error")).toHaveText("เชื่อมต่อระบบไม่ได้ กรุณาลองใหม่อีกครั้ง");
  await page.goto("/admin");
  await expect(page.getByRole("heading", { name: "เข้าสู่ระบบพนักงาน" })).toBeVisible();
  await page.getByLabel("รหัสผ่าน").fill(process.env.PILOT_ADMIN_PASSWORD ?? "pilot-admin-local");
  await page.getByRole("button", { name: "เข้าสู่ระบบ", exact: true }).click();
  await expect(page.getByRole("heading", { name: "เข้าสู่ระบบพนักงาน" })).toHaveCount(0);
});
