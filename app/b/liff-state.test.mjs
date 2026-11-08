import test from "node:test";
import assert from "node:assert/strict";
import { liffTarget, liffRedirect } from "./liff-state.mjs";

test("a LIFF link opens the shop's booking page or a booking's own link", () => {
  assert.equal(liffTarget("/bloom-hair"), "/b/bloom-hair");
  assert.equal(liffTarget("%2Fbloom-hair"), "/b/bloom-hair");
  assert.equal(liffTarget("bloom-hair/"), "/b/bloom-hair");
  assert.equal(liffTarget("/b/bloom-hair"), "/b/bloom-hair");
  assert.equal(liffTarget("/bloom-hair?utm=line#x"), "/b/bloom-hair");
  assert.equal(liffTarget("/bloom-hair/manage/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"), "/b/bloom-hair/manage/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
  assert.equal(liffTarget("/bloom-hair/me"), "/b/bloom-hair/me");
  assert.equal(liffTarget("/bloom-hair/services"), "/b/bloom-hair/services");
  assert.equal(liffTarget("/bloom-hair/review"), "/b/bloom-hair/review");
  assert.equal(liffTarget("/bloom-hair/review/KM1234"), "/b/bloom-hair/review/KM1234");
  assert.equal(liffTarget("/bloom-hair/line-preview"), "/b/bloom-hair/line-preview");
  // a shop owner linking LINE for Kiwmee's notices (B8)
  assert.equal(liffTarget("/owner-line/AbCdEfGhIjKlMnOpQrStUv_-"), "/b/owner-line/AbCdEfGhIjKlMnOpQrStUv_-");
  assert.equal(liffTarget("/owner-line/short"), null);
  assert.equal(liffTarget("/owner-line/AbCdEfGhIjKlMnOpQrStUv_-/x"), null);
});

test("anything else goes home, never to another site", () => {
  for (const bad of [undefined, "", "/", "//evil.example", "https://evil.example/x", "/bloom-hair/../../admin", "/Bloom", "/bloom-hair/manage/short", "/bloom-hair/me/x", "/bloom-hair/mee", "%E0%A4%A", "/x"]) {
    assert.equal(liffTarget(bad), null, String(bad));
  }
});

test("signing in with LINE in a browser: the sign-in code goes along to the shop's page", () => {
  assert.equal(
    liffRedirect({ "liff.state": "/jackshop", code: "abc123", state: "xyz", liffClientId: "2010969802", liffRedirectUri: "https://kiwmee.up.railway.app/b/jackshop" }),
    "/b/jackshop?code=abc123&state=xyz&liffClientId=2010969802&liffRedirectUri=https%3A%2F%2Fkiwmee.up.railway.app%2Fb%2Fjackshop"
  );
  assert.equal(liffRedirect({ "liff.state": "/jackshop" }), "/b/jackshop");
  assert.equal(liffRedirect({ "liff.state": ["/jackshop/me", "/x"], code: ["a", "b"] }), "/b/jackshop/me?code=a&code=b");
  // nowhere else, whatever comes with it
  assert.equal(liffRedirect({ "liff.state": "//evil.example", code: "abc" }), "/");
  assert.equal(liffRedirect({}), "/");
});
