const { defineConfig } = require("@playwright/test");
module.exports = defineConfig({ testDir: "./e2e", workers: 1, timeout: 60000,
  use: { baseURL: process.env.PILOT_BASE_URL ?? "http://127.0.0.1:3000", browserName: "chromium",
    channel: "msedge", headless: true, screenshot: "only-on-failure" },
  reporter: "list" });
