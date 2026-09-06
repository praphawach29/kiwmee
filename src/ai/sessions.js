const { randomUUID, randomBytes } = require("node:crypto");
const { forbidden, AppError } = require("../errors");
const { same } = require("../security/access");
class MemorySessionStore {
  constructor({ now = Date.now, ttlMs = 30 * 60 * 1000 } = {}) { this.now = now; this.ttlMs = ttlMs; this.sessions = new Map(); this.locks = new Map(); }
  create() {
    for (const [key, value] of this.sessions) if (value.expires < this.now()) this.sessions.delete(key);
    if (this.sessions.size >= 1000) throw new AppError("RATE_LIMITED", "กรุณาลองใหม่ภายหลัง", 429);
    const session = { id: randomUUID(), owner: randomBytes(32).toString("hex"), expires: this.now() + this.ttlMs,
      stage: "start", services: [], staffList: [], slots: [], service: null, staff: null, date: null, slot: null,
      customer: null, booking: null, pending: null, handoff: false, action: "create" };
    this.sessions.set(session.id, session); return session;
  }
  get(id, owner) {
    const session = this.sessions.get(id);
    if (!session || session.expires < this.now() || !same(session.owner, owner)) throw forbidden("เซสชันหมดอายุ กรุณาเริ่มใหม่");
    return session;
  }
  async exclusive(session, callback) {
    if (this.locks.has(session.id)) throw new AppError("BUSY", "กำลังดำเนินการ กรุณารอสักครู่", 409);
    this.locks.set(session.id, true);
    try { return await callback(session); } finally { this.locks.delete(session.id); }
  }
}
const sessionStore = new MemorySessionStore();
module.exports = { MemorySessionStore, sessionStore };
