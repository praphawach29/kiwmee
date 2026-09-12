// Salon Booking OS v1 - LINE / Message Content Provider Abstraction
// Safely ingests and validates media attachments without leaking raw image data to logs or LLMs.

const { createHash } = require("node:crypto");

const ALLOWED_MIME_TYPES = Object.freeze(["image/jpeg", "image/png"]);
const DEFAULT_MAX_IMAGE_SIZE_BYTES = 5 * 1024 * 1024; // 5 MB

class MessageContentProvider {
  /**
   * Retrieves binary image content by message ID.
   * @param {string} messageId
   * @returns {Promise<{ buffer: Buffer, contentType: string }>}
   */
  async getImageContent(messageId) {
    throw new Error("getImageContent must be implemented by concrete provider");
  }
}

class MockMessageContentProvider extends MessageContentProvider {
  constructor(defaultImage = null) {
    super();
    this.images = new Map();
    // 1x1 transparent PNG as default fallback test binary
    this.defaultImage = defaultImage || {
      buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64"),
      contentType: "image/png"
    };
  }

  setImage(messageId, { buffer, contentType = "image/jpeg" }) {
    this.images.set(messageId, { buffer, contentType });
  }

  async getImageContent(messageId) {
    if (this.images.has(messageId)) {
      return this.images.get(messageId);
    }
    return this.defaultImage;
  }
}

/**
 * Validates ingested image buffer:
 * - MIME format check (jpeg/png only)
 * - Size limit check (max 5MB)
 * - Empty body check
 * - SHA-256 hash generation
 * 
 * Invariant: Never log or return raw image binary to external loggers!
 */
function validateImageContent(content, options = {}) {
  const maxSize = options.maxSizeBytes || DEFAULT_MAX_IMAGE_SIZE_BYTES;

  if (!content || !content.buffer) {
    return {
      valid: false,
      code: "EMPTY_BODY",
      message: "ไม่พบข้อมูลรูปภาพ กรุณาส่งรูปสลิปใหม่อีกครั้งค่ะ"
    };
  }

  const buffer = content.buffer;
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    return {
      valid: false,
      code: "EMPTY_BODY",
      message: "ไฟล์รูปภาพว่างเปล่า กรุณาส่งรูปสลิปใหม่อีกครั้งค่ะ"
    };
  }

  if (buffer.length > maxSize) {
    return {
      valid: false,
      code: "OVERSIZED_IMAGE",
      message: `ขนาดรูปภาพใหญ่เกินกำหนด (สูงสุด ${Math.round(maxSize / (1024 * 1024))}MB) กรุณาลดขนาดภาพค่ะ`
    };
  }

  const contentType = (content.contentType || "").toLowerCase().trim();
  if (!ALLOWED_MIME_TYPES.includes(contentType)) {
    return {
      valid: false,
      code: "INVALID_MIME_TYPE",
      message: "รองรับเฉพาะไฟล์รูปภาพ JPG หรือ PNG เท่านั้นค่ะ"
    };
  }

  const hash = createHash("sha256").update(buffer).digest("hex");

  return {
    valid: true,
    hash,
    size: buffer.length,
    contentType
  };
}

module.exports = {
  ALLOWED_MIME_TYPES,
  DEFAULT_MAX_IMAGE_SIZE_BYTES,
  MessageContentProvider,
  MockMessageContentProvider,
  validateImageContent
};
