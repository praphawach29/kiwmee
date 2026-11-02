// PromptPay QR for a transfer deposit: the standard Thai QR (EMVCo merchant-presented, tag 29 =
// PromptPay) with the amount filled in, so the customer scans it in any bank app and the amount is
// already there. Built here from the shop's PromptPay number (phone 10 digits or ID 13 digits);
// no outside service sees anything.

const QRCode = require("qrcode");

const field = (id, value) => `${id}${String(value.length).padStart(2, "0")}${value}`;

// CRC-16/CCITT-FALSE (poly 0x1021, start 0xFFFF), as the Thai QR standard asks
function crc16(text) {
  let crc = 0xffff;
  for (let i = 0; i < text.length; i++) {
    crc ^= text.charCodeAt(i) << 8;
    for (let b = 0; b < 8; b++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc.toString(16).toUpperCase().padStart(4, "0");
}

/** The text inside the QR, or null when the number is not a PromptPay phone or ID */
function promptPayPayload(promptPay, amount) {
  const id = String(promptPay ?? "").replace(/[^0-9]/g, "");
  let account;
  if (/^0[0-9]{9}$/.test(id)) account = field("01", `0066${id.slice(1)}`); // mobile: 0066 + number without the 0
  else if (/^[0-9]{13}$/.test(id)) account = field("02", id); // national ID / tax ID
  else return null;
  const value = Number(amount);
  const withAmount = Number.isFinite(value) && value > 0;
  const body =
    field("00", "01") +
    field("01", withAmount ? "12" : "11") + // 12 = for this one payment, 11 = reusable
    field("29", field("00", "A000000677010111") + account) +
    field("58", "TH") +
    field("53", "764") +
    (withAmount ? field("54", value.toFixed(2)) : "") +
    "6304";
  return body + crc16(body);
}

/** The QR as a PNG data URL for an <img> (a picture the customer can also save to their phone), or null */
async function promptPayQr(promptPay, amount) {
  const payload = promptPayPayload(promptPay, amount);
  if (!payload) return null;
  return QRCode.toDataURL(payload, { errorCorrectionLevel: "M", margin: 2, width: 480, color: { dark: "#1B1640", light: "#FFFFFF" } });
}

module.exports = { promptPayPayload, promptPayQr, crc16 };
