// LINE's in-app browser: "เข้าสู่ระบบ" reopens the page through the LIFF URL (app/b/[slug]/use-liff.jsx)
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { transformSync } from "next/dist/build/swc/index.js";

const source = readFileSync(new URL("./use-liff.jsx", import.meta.url), "utf8");
const { code } = transformSync(source, { filename: "use-liff.jsx", jsc: { parser: { syntax: "ecmascript", jsx: true } }, module: { type: "commonjs" } });
const mod = { exports: {} };
new Function("module", "exports", "require", code)(mod, mod.exports, (name) => (name === "react" ? { useEffect() {}, useState: (v) => [v, () => {}] } : {}));
const { liffUrlFor, inLineApp } = mod.exports;

test("the LIFF URL for a page under /b keeps the rest of the path and the query", () => {
  assert.equal(liffUrlFor("123-abc", { pathname: "/b/jackshop", search: "" }), "https://liff.line.me/123-abc/jackshop");
  assert.equal(liffUrlFor("123-abc", { pathname: "/b/jackshop/me", search: "?tab=points" }), "https://liff.line.me/123-abc/jackshop/me?tab=points");
  assert.equal(liffUrlFor("123-abc", { pathname: "/b" }), "https://liff.line.me/123-abc/");
});

test("LINE's in-app browser is told apart by its user agent", () => {
  assert.equal(inLineApp("Mozilla/5.0 (Linux; Android 14) Chrome/126 Mobile Safari/537.36 Line/14.20.0"), true);
  assert.equal(inLineApp("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) Mobile/15E148 Line/14.19.1/IAB"), true);
  assert.equal(inLineApp("Mozilla/5.0 (Linux; Android 14) Chrome/126 Mobile Safari/537.36"), false);
  assert.equal(inLineApp("Mozilla/5.0 Mobile Safari/537.36 Online/1.0"), false);
});
