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
});

test("anything else goes home, never to another site", () => {
  for (const bad of [undefined, "", "/", "//evil.example", "https://evil.example/x", "/bloom-hair/../../admin", "/Bloom", "/bloom-hair/manage/short", "%E0%A4%A", "/x"]) {
    assert.equal(liffTarget(bad), null, String(bad));
  }
});
