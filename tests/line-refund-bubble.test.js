const test = require("node:test");
const assert = require("node:assert/strict");

const { buildRefundSuccessBubble } = require("../src/messaging/line-flex-builder");

test("buildRefundSuccessBubble builds valid LINE Flex Message matching Stitch Screen 8", () => {
  const result = buildRefundSuccessBubble({
    booking: { id: "bk-8824-xyz", serviceName: "ตัดแต่งทรงผมสไตล์เกาหลี + Olaplex" },
    refund: { amount: 500, reference: "RF-20260325-091", destination: "PromptPay (081-xxx-8899)" },
    shop: { name: "Kiwmee Studio", slug: "kiwmee-studio" },
    couponCode: "COMEBACK10"
  });

  assert.equal(result.type, "flex");
  assert.match(result.altText, /แจ้งคืนเงินมัดจำสำเร็จ/);
  assert.match(result.altText, /500/);

  const bubble = result.contents;
  assert.equal(bubble.type, "bubble");
  assert.equal(bubble.size, "mega");

  // Header check
  assert.equal(bubble.header.backgroundColor, "#6A4CFF");
  const headerTexts = JSON.stringify(bubble.header);
  assert.match(headerTexts, /Kiwmee Auto Refund/);
  assert.match(headerTexts, /แจ้งคืนเงินมัดจำสำเร็จ/);
  assert.match(headerTexts, /อนุมัติแล้ว 100%/);

  // Body check
  const bodyTexts = JSON.stringify(bubble.body);
  assert.match(bodyTexts, /500/);
  assert.match(bodyTexts, /PromptPay \(081-xxx-8899\)/);
  assert.match(bodyTexts, /RF-20260325-091/);
  assert.match(bodyTexts, /COMEBACK10/);
  assert.match(bodyTexts, /ยกเลิกล่วงหน้า > 2 ชม\./);

  // Footer check
  const footerButtons = bubble.footer.contents;
  assert.equal(footerButtons.length, 2);
  assert.equal(footerButtons[0].action.label, "ตรวจสอบสถานะ / ใบเสร็จ LIFF");
  assert.equal(footerButtons[1].action.label, "จองคิวใหม่ทันที");
});

