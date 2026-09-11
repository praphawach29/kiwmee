// Salon Booking OS v1 - Payment Money Boundary
// Safe conversion between Domain Integer Satang (1 THB = 100 Satang) and PostgreSQL numeric(10,2)

/**
 * Converts a Baht value (numeric or string) into integer Satang.
 * Guards against floating-point inaccuracies.
 * 
 * Examples:
 * 0.01 -> 1
 * 0.10 -> 10
 * 500.00 -> 50000
 * 2500.75 -> 250075
 */
function toSatang(amountInBaht) {
  if (amountInBaht === null || amountInBaht === undefined || amountInBaht === "") {
    throw new Error(`Invalid monetary amount: ${amountInBaht}`);
  }
  const num = typeof amountInBaht === "string" ? Number.parseFloat(amountInBaht) : Number(amountInBaht);
  if (!Number.isFinite(num) || num < 0) {
    throw new Error(`Invalid monetary amount: ${amountInBaht}`);
  }
  return Math.round(num * 100);
}

/**
 * Converts integer Satang back to standard Baht number with 2 decimal precision.
 */
function fromSatang(satang) {
  if (!Number.isInteger(satang) || satang < 0) {
    throw new Error(`Invalid satang amount: ${satang}`);
  }
  return Number((satang / 100).toFixed(2));
}

/**
 * Encodes monetary amount for PostgreSQL numeric(10,2) column.
 * Always produces a normalized, 2-decimal string representation ("XX.XX")
 * to avoid JavaScript floating point representation quirks in SQL parameters.
 * 
 * @param {number|string} amountInBaht - Amount in Baht (float or string)
 * @returns {string} String formatted as "XX.XX"
 */
function encodeMoneyForDb(amountInBaht) {
  const satang = toSatang(amountInBaht);
  return (satang / 100).toFixed(2);
}

/**
 * Decodes a PostgreSQL numeric(10,2) value returned by pg driver into
 * both integer satang and a clean Baht number.
 * 
 * @param {string|number} dbAmount - Value returned from PostgreSQL numeric column
 * @returns {{ satang: number, baht: number, formatted: string }}
 */
function decodeMoneyFromDb(dbAmount) {
  const satang = toSatang(dbAmount);
  return {
    satang,
    baht: fromSatang(satang),
    formatted: (satang / 100).toFixed(2)
  };
}

module.exports = {
  toSatang,
  fromSatang,
  encodeMoneyForDb,
  decodeMoneyFromDb
};
