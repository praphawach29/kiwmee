const test = require("node:test");
const assert = require("node:assert/strict");
const { validateMedia } = require("../src/v2/media-validation");

const media = [{ url: "https://images.example.com/court.jpg?width=800", alt: "สนามกีฬา" }, { url: "/demo-media/jackshop/court.webp", alt: "" }];

test("media accepts an ordered gallery of HTTPS and local demo references", () => {
  assert.deepEqual(validateMedia(media), media);
  assert.deepEqual(validateMedia([]), []);
  assert.equal(validateMedia(undefined), undefined, "omission means preserve, not clear");
});

const admin = require("../src/v2/admin-catalog");
test("save APIs reject unsafe galleries before any SQL or network call", async () => {
  const client = { query: () => { assert.fail("invalid media must not reach SQL"); } };
  const shop = { id: "b1000000-0000-4000-8000-000000000001", kind: "court" };
  await assert.rejects(admin.saveShop(client, shop, { name: "Sport", media: [{ url: "http://evil.test/a", alt: "" }] }), invalid);
  await assert.rejects(admin.saveOffering(client, shop, null, { name: "Sport", durationMinutes: 30, media: null }), invalid);
});

const invalid = (error) => error.code === "INVALID" && error.status === 422;
test("media rejects malformed entries, limits, and unsafe URL forms without coercion", () => {
  const urls = ["data:image/png;base64,abc", "javascript:alert(1)", "http://example.com/a.jpg", "//example.com/a.jpg", "/other/a.jpg", "https://user:secret@example.com/a", "https://@example.com/a", "https:///example.com/a", "https://example.com\\\\evil/a", "https://example.com/\na", " https://example.com/a", "/demo-media/../secret", "/demo-media/%2e%2e/secret", "/demo-media/a/../../secret", "/demo-media/", "https://", "https://bad host/a"];
  for (const url of urls) assert.throws(() => validateMedia([{ url, alt: "" }]), invalid, url);
  for (const value of [null, {}, "[]", [null], ["url"], [{ url: 1, alt: "" }], [{ url: media[0].url }], [{ url: media[0].url, alt: null }], [{ ...media[0], extra: true }], Array(9).fill(media[0]), [{ url: `https://example.com/${"a".repeat(2048)}`, alt: "" }], [{ url: media[0].url, alt: "a".repeat(201) }]]) {
    assert.throws(() => validateMedia(value), invalid);
  }
  assert.equal(validateMedia(Array(8).fill(media[0])).length, 8);
  assert.equal(validateMedia([{ url: "https://example.com/" + "a".repeat(2028), alt: "a".repeat(200) }])[0].url.length, 2048);
});
