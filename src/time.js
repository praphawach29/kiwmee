const BANGKOK_OFFSET_MINUTES = 7 * 60;

function addMinutes(date, minutes) {
  return new Date(date.getTime() + minutes * 60 * 1000);
}

function bkkDateRange(dateText) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateText)) {
    throw new Error("date must be YYYY-MM-DD");
  }

  const start = new Date(`${dateText}T00:00:00+07:00`);
  const end = addMinutes(start, 24 * 60);
  return { start, end };
}

function toBangkokISOString(date) {
  const shifted = new Date(date.getTime() + BANGKOK_OFFSET_MINUTES * 60 * 1000);
  const pad = (value) => String(value).padStart(2, "0");

  return [
    shifted.getUTCFullYear(),
    "-",
    pad(shifted.getUTCMonth() + 1),
    "-",
    pad(shifted.getUTCDate()),
    "T",
    pad(shifted.getUTCHours()),
    ":",
    pad(shifted.getUTCMinutes()),
    ":",
    pad(shifted.getUTCSeconds()),
    "+07:00"
  ].join("");
}

function overlaps(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && aEnd > bStart;
}

function maxDate(a, b) {
  return a > b ? a : b;
}

function minDate(a, b) {
  return a < b ? a : b;
}

module.exports = {
  addMinutes,
  bkkDateRange,
  maxDate,
  minDate,
  overlaps,
  toBangkokISOString
};
