import test from "node:test";
import assert from "node:assert/strict";
import { liffTarget } from "./liff-state.mjs";

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
});

test("anything else goes home, never to another site", () => {
  for (const bad of [undefined, "", "/", "//evil.example", "https://evil.example/x", "/bloom-hair/../../admin", "/Bloom", "/bloom-hair/manage/short", "/bloom-hair/me/x", "/bloom-hair/mee", "%E0%A4%A", "/x"]) {
    assert.equal(liffTarget(bad), null, String(bad));
  }
});
