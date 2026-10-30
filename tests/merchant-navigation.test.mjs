import test from "node:test";
import assert from "node:assert/strict";
import { shopNavigation, shopTabs, resolveShopTab, homeTabFromHash } from "../app/dashboard/merchant-navigation.mjs";

test("owners see existing daily operations and shop settings", () => {
  const groups = shopNavigation("owner");
  assert.deepEqual(groups.flatMap((group) => group.items.map((item) => item.id)),
    ["shops", "bookings", "bills", "flow", "offerings", "resources", "hours"]);
  assert.equal(groups.find((group) => group.label === "ตั้งค่าร้าน").collapsible, true);
});

test("staff see daily operations but no settings", () => {
  const groups = shopNavigation("staff");
  assert.deepEqual(groups.flatMap((group) => group.items.map((item) => item.id)), ["shops", "bookings", "bills"]);
});

test("tab definitions match sidebar items and reject restricted or invalid requests", () => {
  for (const role of ["owner", "staff", "unknown"]) {
    const tabs = shopTabs(role);
    assert.deepEqual(tabs, shopNavigation(role).flatMap((group) => group.items).filter((item) => !item.href));
    for (const tab of tabs) assert.equal(resolveShopTab(role, tab.id), tab.id);
    for (const invalid of ["not-a-tab", "shops", "toString", "__proto__", "#hours", null, undefined, ""]) {
      assert.equal(resolveShopTab(role, invalid), tabs[0]?.id ?? null);
    }
  }
  for (const id of ["flow", "offerings", "resources", "hours"]) assert.equal(resolveShopTab("staff", id), "bookings");
  assert.equal(resolveShopTab("unknown", "bookings"), null);
});

test("home hash selects the matching menu without consuming auth callback hashes", () => {
  assert.equal(homeTabFromHash("#merchant-create"), "create");
  assert.equal(homeTabFromHash("#merchant-shops"), "shops");
  assert.equal(homeTabFromHash(""), "shops");
  assert.equal(homeTabFromHash("#invalid"), "shops");
  for (const hash of ["#access_token=secret&refresh_token=secret&type=recovery", "#error_description=expired", "#type=signup", "#access_token=secret"]) {
    assert.equal(homeTabFromHash(hash), null);
  }
});

test("unknown roles fail closed", () => {
  for (const role of [undefined, null, "admin", "OWNER", "", "toString"]) {
    assert.deepEqual(shopNavigation(role).flatMap((group) => group.items.map((item) => item.id)), ["shops"]);
  }
});
