const { randomBytes, randomUUID, createHmac } = require("node:crypto");
function createSessionState(channel = { type: "web" }) {
  return { id: randomUUID(), expires_at: new Date(Date.now() + 30 * 60 * 1000).toISOString(), stage: "start",
    services: [], staffList: [], slots: [], service: null, staff: null, date: null, slot: null,
    customer: null, booking: null, pending: null, handoff: false, action: "create", channel };
}
class PersistentSessionStore {
  constructor(repository) { this.repository = repository; }
  async create(channel) {
    const owner = randomBytes(32).toString("hex"); const session = createSessionState(channel);
    return { session: await this.repository.createSession(session, owner), owner };
  }
  async withSession(id, owner, callback) {
    try { return await this.repository.withSession(id, owner, callback); }
    catch (error) {
      if (error.code === "FORBIDDEN") throw require("../errors").forbidden("เซสชันหมดอายุ กรุณาเริ่มใหม่");
      throw error;
    }
  }
  async external(lineUserId, secret) {
    const externalKey = `line:${lineUserId}`;
    const owner = createHmac("sha256", secret).update(externalKey).digest("hex");
    const session = await this.repository.getOrCreateExternalSession(externalKey, owner,
      () => createSessionState({ type: "line", user_id: lineUserId }));
    return { session, owner };
  }
}
module.exports = { PersistentSessionStore, createSessionState };
