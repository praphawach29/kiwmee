const { defineConfig } = require("@playwright/test");
module.exports = defineConfig({ testDir: "./e2e", workers: 1, timeout: 60000,
  use: { baseURL: process.env.PILOT_BASE_URL ?? "http://127.0.0.1:3000", browserName: "chromium",
    // PW_EXECUTABLE: a local Chromium build instead of Edge (e.g. in CI containers)
    ...(process.env.PW_EXECUTABLE ? { launchOptions: { executablePath: process.env.PW_EXECUTABLE } } : { channel: "msedge" }),
    headless: true, screenshot: "only-on-failure" },
  reporter: "list" });
