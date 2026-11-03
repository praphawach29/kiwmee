// แผนผังสนาม (migration …002900): each court / table / room may sit on a grid up to 12 × 12,
// at (row, col), w columns wide and h rows tall. Shared by the shop's editor, the server's check
// and the customer's map, so all three agree on what fits.

const MAX = 12;
const MAX_SPAN = 6;

const whole = (v) => Number.isInteger(v);

/** null, or { row, col, w, h } after checking it fits on the grid */
function cleanSpot(spot) {
  if (spot === null || spot === undefined) return null;
  const { row, col } = spot;
  const w = spot.w ?? 1;
  const h = spot.h ?? 1;
  if (![row, col, w, h].every(whole)) return undefined;
  if (row < 1 || col < 1 || w < 1 || h < 1 || w > MAX_SPAN || h > MAX_SPAN) return undefined;
  if (row + h - 1 > MAX || col + w - 1 > MAX) return undefined;
  return { row, col, w, h };
}

const cellsOf = (s) => {
  const out = [];
  for (let r = s.row; r < s.row + s.h; r++) for (let c = s.col; c < s.col + s.w; c++) out.push(`${r}:${c}`);
  return out;
};

/** The first two placed items that overlap, or null */
function overlap(items) {
  const taken = new Map();
  for (const item of items) {
    if (!item.layout) continue;
    for (const cell of cellsOf(item.layout)) {
      if (taken.has(cell)) return [taken.get(cell), item];
      taken.set(cell, item);
    }
  }
  return null;
}

/** How big the map is: just enough rows and columns for what is placed */
function gridSize(items) {
  let rows = 0;
  let cols = 0;
  for (const { layout: s } of items) {
    if (!s) continue;
    rows = Math.max(rows, s.row + s.h - 1);
    cols = Math.max(cols, s.col + s.w - 1);
  }
  return { rows, cols };
}

/** From a database row (layout_row …) */
const layoutOf = (r) => (r.layout_row ? { row: r.layout_row, col: r.layout_col, w: r.layout_w ?? 1, h: r.layout_h ?? 1 } : null);

module.exports = { MAX, MAX_SPAN, cleanSpot, overlap, gridSize, layoutOf };
