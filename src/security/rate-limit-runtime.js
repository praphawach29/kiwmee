const { getPilotRepository } = require("../repositories/pilot");
const { PersistentRateLimiter } = require("./persistent-rate-limit");
let limiter;
function getRateLimiter() { if (!limiter) limiter = new PersistentRateLimiter(getPilotRepository()); return limiter; }
function clientKey(request) { return request.headers.get("x-forwarded-for")?.split(",")[0].trim() ?? request.headers.get("user-agent") ?? "unknown"; }
module.exports = { getRateLimiter, clientKey };
