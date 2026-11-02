const test = require("node:test");
const assert = require("node:assert/strict");
const { saveResource } = require("../src/v2/admin-catalog");

const shop = { id: "b1000000-0000-4000-8000-000000000001" };
const gallery = [{ url: "https://example.com/court.webp", alt: "Court" }];

test("saveResource rejects invalid galleries before any SQL", async () => {
  for (const media of [null, {}, [null], [{ url: "http://example.com/a", alt: "" }], Array(9).fill(gallery[0]), [{ ...gallery[0], extra: true }]]) {
    let queries = 0;
    const client = { query: async () => { queries++; return { rows: [{ id: shop.id }], rowCount: 1 }; } };
    await assert.rejects(saveResource(client, shop, null, { kind: "court", name: "Court", media }), (error) => error.status === 422);
    assert.equal(queries, 0);
  }
});
