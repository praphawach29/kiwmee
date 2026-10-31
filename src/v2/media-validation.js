const { AppError } = require("../errors");

const MAX_MEDIA = 8;
const MAX_MEDIA_URL_LENGTH = 2048;
const MAX_MEDIA_ALT_LENGTH = 200;

// References only. Never download, probe, or proxy owner-supplied media URLs here.
function validateMedia(value) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > MAX_MEDIA) {
    throw new AppError("INVALID", "รูปภาพต้องเป็นรายการไม่เกิน 8 รูป", 422);
  }
  const fail = () => { throw new AppError("INVALID", "รูปภาพต้องมี URL แบบ HTTPS หรือ /demo-media/ และคำอธิบายไม่เกิน 200 ตัวอักษร", 422); };
  return value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item) || Object.keys(item).length !== 2 ||
        typeof item.url !== "string" || typeof item.alt !== "string") fail();
    const { url, alt } = item;
    if (!url.length || url.length > MAX_MEDIA_URL_LENGTH || alt.length > MAX_MEDIA_ALT_LENGTH ||
        /[\s\\\x00-\x1f\x7f]/u.test(url) || /[\x00-\x1f\x7f]/u.test(alt)) fail();
    if (url.startsWith("/demo-media/")) {
      // Static local assets only; no encoded or literal path traversal.
      if (!/^\/demo-media\/(?:[A-Za-z0-9_-][A-Za-z0-9._-]*\/)*[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(url)) fail();
    } else {
      // The authority cannot contain credentials, backslashes, or URL-parser repairs.
      if (!/^https:\/\/(?:[A-Za-z0-9][A-Za-z0-9.-]*|\[[0-9A-Fa-f:]+\])(?::[0-9]{1,5})?(?:[/?#]|$)/.test(url)) fail();
      try {
        const parsed = new URL(url);
        if (parsed.protocol !== "https:" || !parsed.hostname || parsed.username || parsed.password) fail();
      } catch { fail(); }
    }
    return { url, alt };
  });
}

module.exports = { validateMedia, MAX_MEDIA, MAX_MEDIA_URL_LENGTH, MAX_MEDIA_ALT_LENGTH };
