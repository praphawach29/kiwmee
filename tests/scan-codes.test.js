const test = require("node:test");
const assert = require("node:assert/strict");
const { scanUrl, bookingCode, parseScan } = require("../src/v2/scan-codes");

const ID = "1a2b3c4d-0000-4000-8000-000000000001";

test("booking QR: the link, the raw value and the typed 8-character code all find the booking", () => {
  const url = scanUrl("https://kiwmee.up.railway.app", "bloom-hair", "b", ID);
  assert.equal(url, `https://kiwmee.up.railway.app/dashboard/bloom-hair?scan=b-${ID}`);
  assert.deepEqual(parseScan(url), { kind: "booking", ref: ID });
  assert.deepEqual(parseScan(`b-${ID}`), { kind: "booking", ref: ID });
  assert.equal(bookingCode(ID), "1A2B3C4D");
  assert.deepEqual(parseScan(" 1a2b 3C4D "), { kind: "booking", ref: "1a2b3c4d" });
});

test("member QR: the link or the 6 digits typed", () => {
  assert.deepEqual(parseScan(scanUrl("https://x.test", "s", "m", "482913")), { kind: "member", code: "482913" });
  assert.deepEqual(parseScan("482 913"), { kind: "member", code: "482913" });
});

test("anything else is not ours", () => {
  for (const text of ["", "hello", "https://example.com/", "https://x.test/?scan=m-12", "b-482913", "m-1a2b3c4d", "00020101021129370016A000000677010111"]) {
    assert.equal(parseScan(text), null, text);
  }
});
