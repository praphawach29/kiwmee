// PromptPay QR payload (src/v2/promptpay.js): the Thai QR standard, checked against a known payload
// from the widely used promptpay-qr library and the standard CRC check value.
const test = require("node:test");
const assert = require("node:assert/strict");
const { promptPayPayload, promptPayQr, crc16 } = require("../src/v2/promptpay");

test("CRC-16/CCITT-FALSE check value", () => {
  assert.equal(crc16("123456789"), "29B1");
});

test("a phone number with an amount gives the standard one-time payload", () => {
  assert.equal(promptPayPayload("000-000-0000", 4.22), "00020101021229370016A000000677010111011300660000000005802TH530376454044.226304E469");
  const p = promptPayPayload("081-234-5678", 200);
  assert.match(p, /^000201010212/); // one-time (12) because it has an amount
  assert.match(p, /01130066812345678/);
  assert.match(p, /5406200\.00/);
  assert.equal(p.slice(-4), crc16(p.slice(0, -4)));
});

test("a 13-digit ID uses its own tag; no amount = reusable; anything else = no QR", () => {
  const id = promptPayPayload("1234567890123");
  assert.match(id, /^000201010211/);
  assert.match(id, /02131234567890123/);
  assert.doesNotMatch(id, /54\d\d/);
  for (const bad of [null, "", "12345", "081234567", "1081234567", "abc"]) assert.equal(promptPayPayload(bad, 100), null, String(bad));
});

test("the QR is a PNG data URL, or null without a PromptPay number", async () => {
  assert.match(await promptPayQr("0812345678", 135), /^data:image\/png;base64,/);
  assert.equal(await promptPayQr(undefined, 135), null);
});
