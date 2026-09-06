const { createHash } = require("node:crypto");
let Pool;

function hash(value) { return createHash("sha256").update(String(value)).digest("hex"); }

class PgPilotRepository {
  constructor(options = {}) {
    if (!Pool) ({ Pool } = require("pg"));
    this.pool = options.pool ?? new Pool({ connectionString: options.connectionString ?? process.env.DATABASE_URL,
      ssl: process.env.PGSSL === "true" ? { rejectUnauthorized: false } : false });
    this.ownsPool = !options.pool;
  }
  async close() { if (this.ownsPool) await this.pool.end(); }
  async createSession(session, owner, externalKey = null) {
    const result = await this.pool.query(`insert into ai_sessions(id, owner_hash, external_key_hash, state, expires_at)
      values($1,$2,$3,$4::jsonb,$5) returning *`,
    [session.id, hash(owner), externalKey ? hash(externalKey) : null, JSON.stringify(session), session.expires_at]);
    return this.hydrate(result.rows[0]);
  }
  async getOrCreateExternalSession(externalKey, owner, createState) {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const key = hash(externalKey);
      let row = (await client.query("select * from ai_sessions where external_key_hash=$1 for update", [key])).rows[0];
      if (!row || new Date(row.expires_at) <= new Date()) {
        if (row) await client.query("delete from ai_sessions where id=$1", [row.id]);
        const state = createState();
        row = (await client.query(`insert into ai_sessions(id,owner_hash,external_key_hash,state,expires_at)
          values($1,$2,$3,$4::jsonb,$5) returning *`, [state.id, hash(owner), key, JSON.stringify(state), state.expires_at])).rows[0];
      }
      await client.query("commit"); return this.hydrate(row);
    } catch (error) { await client.query("rollback"); throw error; } finally { client.release(); }
  }
  async withSession(id, owner, callback) {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const row = (await client.query("select * from ai_sessions where id=$1 for update", [id])).rows[0];
      if (!row || row.owner_hash !== hash(owner) || new Date(row.expires_at) <= new Date()) {
        const error = new Error("session unavailable"); error.code = "FORBIDDEN"; throw error;
      }
      const session = this.hydrate(row);
      const afterCommit = [];
      Object.defineProperty(session, "deferAfterCommit", { value: (fn) => afterCommit.push(fn), enumerable: false });
      const result = await callback(session);
      session.expires_at = new Date(Date.now() + 30 * 60 * 1000).toISOString();
      await client.query(`update ai_sessions set state=$2::jsonb, expires_at=$3, version=version+1 where id=$1`,
        [id, JSON.stringify(session), session.expires_at]);
      await client.query("commit");
      for (const fn of afterCommit) await fn();
      return result;
    } catch (error) { await client.query("rollback"); throw error; } finally { client.release(); }
  }
  hydrate(row) { return { ...row.state, id: row.id, expires_at: new Date(row.expires_at).toISOString(), version: row.version }; }
  async cleanup(now = new Date()) {
    const sessions = await this.pool.query("delete from ai_sessions where expires_at <= $1", [now]);
    const limits = await this.pool.query("delete from rate_limits where expires_at <= $1", [now]);
    const revocations = await this.pool.query("delete from admin_session_revocations where expires_at <= $1", [now]);
    return { sessions: sessions.rowCount, rate_limits: limits.rowCount, revocations: revocations.rowCount };
  }
  async consumeRateLimit(scope, key, { max, windowMs }, now = new Date()) {
    const startMs = Math.floor(now.getTime() / windowMs) * windowMs;
    const start = new Date(startMs); const expires = new Date(startMs + windowMs);
    const result = await this.pool.query(`insert into rate_limits(key_hash,window_start,count,expires_at)
      values($1,$2,1,$3) on conflict(key_hash,window_start) do update set count=rate_limits.count+1 returning count`,
    [hash(`${scope}:${key}`), start, expires]);
    return { allowed: result.rows[0].count <= max, count: result.rows[0].count, reset_at: expires.toISOString() };
  }
  async createHandoff(input) {
    const result = await this.pool.query(`insert into handoff_requests(session_id,booking_id,customer_channel,destination,reason)
      values($1,$2,$3,$4,$5) on conflict(session_id) where session_id is not null and status in ('pending','accepted')
      do update set reason=handoff_requests.reason returning *`,
    [input.session_id, input.booking_id, input.customer_channel, input.destination, input.reason]);
    return result.rows[0];
  }
  async listHandoffs(status = null) {
    return (await this.pool.query(`select * from handoff_requests where ($1::text is null or status=$1)
      order by case status when 'pending' then 0 when 'accepted' then 1 else 2 end, created_at desc limit 100`, [status])).rows;
  }
  async updateHandoff(id, status) {
    return (await this.pool.query("update handoff_requests set status=$2 where id=$1 returning *", [id, status])).rows[0] ?? null;
  }
  async revokeAdminSession(id, expiresAt) {
    await this.pool.query("insert into admin_session_revocations(session_id,expires_at) values($1,$2) on conflict do nothing", [id, expiresAt]);
  }
  async isAdminSessionRevoked(id) {
    return (await this.pool.query("select 1 from admin_session_revocations where session_id=$1 and expires_at>now()", [id])).rowCount > 0;
  }
  async claimLineEvent(id) {
    return (await this.pool.query(`insert into line_webhook_events(event_id) values($1)
      on conflict(event_id) do update set status='processing',attempts=line_webhook_events.attempts+1,last_error=null
      where line_webhook_events.status='failed' returning *`, [id])).rows[0] ?? null;
  }
  async completeLineEvent(id) { await this.pool.query("update line_webhook_events set status='completed' where event_id=$1", [id]); }
  async failLineEvent(id) { await this.pool.query("update line_webhook_events set status='failed',last_error='webhook processing failed' where event_id=$1", [id]); }
  async health() { await this.pool.query("select 1"); return true; }
}
module.exports = { PgPilotRepository, hash };
