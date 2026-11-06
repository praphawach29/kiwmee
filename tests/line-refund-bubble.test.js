const test = require("node:test");
const assert = require("node:assert/strict");

const { bookingCard } = require("../src/v2/line-notify");

test("bookingCard builds valid refunded LINE Flex Message matching Stitch Screen 8", () => {
  const card = bookingCard({
    kind: "refunded",
    shop: { name: "Kiwmee Studio", timezone: "Asia/Bangkok" },
    booking: {
      offering: "ตัดแต่งทรงผม + Olaplex",
      startAt: "2026-11-10T14:00:00Z",
      endAt: "2026-11-10T15:00:00Z",
      resources: ["ช่างเมย์"]
    },
    link: "https://kiwmee.com/b/kiwmee-studio/me"
  });

  assert.equal(card.type, "flex");
  assert.match(card.altText, /แจ้งคืนเงินมัดจำสำเร็จ/);
  assert.match(card.altText, /Kiwmee Studio/);

  const bubble = card.contents;
  assert.equal(bubble.type, "bubble");
  assert.equal(bubble.size, "mega");

  // Header check
  assert.equal(bubble.header.backgroundColor, "#6A4CFF");
  const headerTexts = JSON.stringify(bubble.header);
  assert.match(headerTexts, /แจ้งคืนเงินมัดจำสำเร็จ/);
  assert.match(headerTexts, /Kiwmee Studio/);

  // Body check
  const bodyTexts = JSON.stringify(bubble.body);
  assert.match(bodyTexts, /ตัดแต่งทรงผม \+ Olaplex/);
  assert.match(bodyTexts, /ช่างเมย์/);

  // Footer check
  const footerContents = JSON.stringify(bubble.footer);
  assert.match(footerContents, /ตรวจสอบสถานะ \/ ใบเสร็จ LIFF/);
  assert.match(footerContents, /https:\/\/kiwmee\.com\/b\/kiwmee-studio\/me/);
});
