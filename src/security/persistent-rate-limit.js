const { AppError } = require("../errors");
class PersistentRateLimiter {
  constructor(repository) { this.repository = repository; }
  async consume(scope, key, options = {}) {
    const result = await this.repository.consumeRateLimit(scope, key || "anonymous",
      { max: options.max ?? 30, windowMs: options.windowMs ?? 60000 });
    if (!result.allowed) throw new AppError("RATE_LIMITED", "ส่งคำขอถี่เกินไป กรุณารอสักครู่", 429,
      { reset_at: result.reset_at });
    return result;
  }
}
module.exports = { PersistentRateLimiter };
