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

test("the public address for links made without a request", () => {
  const { publicOrigin, checkinImageUrl } = require("../src/v2/scan-codes");
  assert.equal(publicOrigin({ PUBLIC_ORIGIN: "https://kiwmee.app/" }), "https://kiwmee.app");
  assert.equal(publicOrigin({ RAILWAY_PUBLIC_DOMAIN: "kiwmee.up.railway.app" }), "https://kiwmee.up.railway.app");
  assert.equal(publicOrigin({ PUBLIC_ORIGIN: "http://insecure.test" }), null);
  assert.equal(publicOrigin({}), null);
  assert.equal(checkinImageUrl("https://k.test", "bloom-hair", ID), `https://k.test/api/b/bloom-hair/checkin-qr/${ID}`);
});

test("the check-in QR picture: a PNG of the scan link, no database; anything else is 404", async () => {
  const { GET } = require("../app/api/b/[slug]/checkin-qr/[id]/route.js");
  const jsQR = require("jsqr");
  const sharp = require("sharp");
  const saved = process.env.PUBLIC_ORIGIN;
  process.env.PUBLIC_ORIGIN = "https://kiwmee.test";
  try {
    const ok = await GET(new Request("http://internal/x"), { params: Promise.resolve({ slug: "bloom-hair", id: ID }) });
    assert.equal(ok.headers.get("content-type"), "image/png");
    const { data, info } = await sharp(Buffer.from(await ok.arrayBuffer())).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    assert.equal(jsQR(new Uint8ClampedArray(data), info.width, info.height).data, `https://kiwmee.test/dashboard/bloom-hair?scan=b-${ID}`);
    for (const params of [{ slug: "bloom-hair", id: "nope" }, { slug: "../x", id: ID }, { slug: "bloom-hair", id: ID.toUpperCase() }]) {
      assert.equal((await GET(new Request("http://internal/x"), { params: Promise.resolve(params) })).status, 404);
    }
  } finally {
    if (saved === undefined) delete process.env.PUBLIC_ORIGIN; else process.env.PUBLIC_ORIGIN = saved;
  }
});
