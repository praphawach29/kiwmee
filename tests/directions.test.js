// "นำทาง" links (src/v2/directions.js): the shop's own map link only from a map site, else a Google
// Maps search for its address; nothing when the shop gave neither.
const test = require("node:test");
const assert = require("node:assert/strict");
const { validMapUrl, directionsLink } = require("../src/v2/directions");
const { bookingCard } = require("../src/v2/line-notify");

test("map links from Google Maps / Apple Maps only, over https", () => {
  for (const ok of ["https://maps.app.goo.gl/AbC123", "https://goo.gl/maps/x", "https://www.google.com/maps/place/x", "https://www.google.co.th/maps/@13.7,100.5,17z", "https://maps.apple.com/?q=x"]) {
    assert.ok(validMapUrl(ok), ok);
  }
  for (const bad of ["http://maps.app.goo.gl/x", "https://evil.example/maps", "https://google.com.evil.example/x", "https://notgoogle.com/x", "https://u:p@goo.gl/x", "javascript:alert(1)", "maps.app.goo.gl/x", "", null]) {
    assert.equal(validMapUrl(bad), null, String(bad));
  }
});

test("the button goes to the map link, else searches the address, else nothing", () => {
  assert.equal(directionsLink({ address: "ที่อยู่", mapUrl: "https://maps.app.goo.gl/AbC" }), "https://maps.app.goo.gl/AbC");
  assert.equal(directionsLink({ address: " 99 ซ.สุขุมวิท 77 ", mapUrl: "https://evil.example" }), `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent("99 ซ.สุขุมวิท 77")}`);
  assert.equal(directionsLink({ address: "", mapUrl: "" }), null);
  assert.equal(directionsLink(), null);
});

test("LINE cards carry a second button to the shop, but not when the booking is cancelled", () => {
  const shop = { name: "JackShop", timezone: "Asia/Bangkok" };
  const booking = { offering: "สนาม", startAt: "2026-11-05T11:00:00Z", endAt: "2026-11-05T12:00:00Z", resources: [], addons: [], total: 0, deposit: null };
  const labels = (card) => card.contents.footer.contents.filter((c) => c.type === "button").map((b) => [b.action.label, b.action.uri]);
  assert.deepEqual(labels(bookingCard({ kind: "remind_soon", shop, booking, link: "https://x/manage", directions: "https://maps.app.goo.gl/a" })), [
    ["ดูการจองของฉัน", "https://x/manage"],
    ["📍 นำทางไปร้าน", "https://maps.app.goo.gl/a"]
  ]);
  assert.deepEqual(labels(bookingCard({ kind: "cancelled", shop, booking, link: "https://x/shop", directions: "https://maps.app.goo.gl/a" })), [["จองคิวใหม่", "https://x/shop"]]);
  assert.deepEqual(labels(bookingCard({ kind: "booked", shop, booking, link: null })), []);
});
