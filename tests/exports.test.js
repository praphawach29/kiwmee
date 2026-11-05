const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

// ทุกไฟล์ใน src/v2 ที่ดึงฟังก์ชันจากไฟล์อื่นด้วย `const { a, b } = require("./x")`
// ต้องดึงชื่อที่ปลายทาง export จริง — กันเคส "undefined is not a function" บน production
// (เคยเกิดขึ้น: wallet.js/platform-revenue.js ใช้ requirePlatformAdmin ที่ไม่ได้ export)
const DIR = path.join(__dirname, "..", "src", "v2");
const DECONSTRUCT = /const\s*\{([^}]+)\}\s*=\s*require\("(\.\/[^"]+)"\)/g;

test("every destructured import in src/v2 exists in the module it comes from", () => {
  const problems = [];
  for (const file of fs.readdirSync(DIR).filter((f) => f.endsWith(".js"))) {
    const source = fs.readFileSync(path.join(DIR, file), "utf8");
    for (const match of source.matchAll(DECONSTRUCT)) {
      const names = match[1]
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean)
        .map((part) => part.split(":")[0].trim());
      const target = match[2];
      let exported;
      try {
        exported = require(path.join(DIR, target));
      } catch (error) {
        problems.push(`${file}: require("${target}") threw ${error.message}`);
        continue;
      }
      for (const name of names) {
        if (!(name in exported)) problems.push(`${file}: "${name}" is not exported by ${target}`);
      }
    }
  }
  assert.deepEqual(problems, []);
});
