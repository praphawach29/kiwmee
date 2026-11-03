const test = require("node:test");
const assert = require("node:assert/strict");
const { cleanSpot, overlap, gridSize, layoutOf } = require("../src/v2/resource-layout");

test("a spot must fit on the 12 × 12 grid", () => {
  assert.deepEqual(cleanSpot({ row: 1, col: 2 }), { row: 1, col: 2, w: 1, h: 1 });
  assert.deepEqual(cleanSpot({ row: 2, col: 1, w: 2, h: 3 }), { row: 2, col: 1, w: 2, h: 3 });
  assert.equal(cleanSpot(null), null);
  for (const bad of [{ row: 0, col: 1 }, { row: 1, col: 13 }, { row: 1, col: 11, w: 3 }, { row: 1, col: 1, w: 7 }, { row: "1", col: 1 }, { row: 1.5, col: 1 }]) {
    assert.equal(cleanSpot(bad), undefined, JSON.stringify(bad));
  }
});

test("two courts may not share a cell; the map is as big as what is placed", () => {
  const a = { id: "a", layout: { row: 1, col: 1, w: 2, h: 1 } };
  const b = { id: "b", layout: { row: 1, col: 3, w: 1, h: 2 } };
  const c = { id: "c", layout: { row: 2, col: 2, w: 2, h: 1 } };
  assert.equal(overlap([a, b, { id: "x", layout: null }]), null);
  assert.deepEqual(overlap([a, b, c]).map((x) => x.id), ["b", "c"]);
  assert.deepEqual(gridSize([a, b]), { rows: 2, cols: 3 });
  assert.deepEqual(gridSize([]), { rows: 0, cols: 0 });
  assert.deepEqual(layoutOf({ layout_row: 2, layout_col: 3, layout_w: 1, layout_h: 2 }), { row: 2, col: 3, w: 1, h: 2 });
  assert.equal(layoutOf({ layout_row: null }), null);
});
