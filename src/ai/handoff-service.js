const { logEvent } = require("../observability/logger");
class HandoffService {
  constructor(repository, config) { this.repository = repository; this.config = config; }
  async create(session, reason) {
    session.handoff = true;
    const input = { session_id: session.id,
      booking_id: session.booking?.id ?? null, customer_channel: session.channel?.type ?? "web",
      destination: this.config.handoffDestination || null, reason };
    const write = async () => {
      const request = await this.repository.createHandoff(input);
      logEvent("handoff_created", { session_id: session.id, booking_id: session.booking?.id,
        channel: input.customer_channel, status: request.status });
      return request;
    };
    if (typeof session.deferAfterCommit === "function") {
      session.deferAfterCommit(write);
      return { deferred: true, status: "pending", ...input };
    }
    return write();
  }
}
module.exports = { HandoffService };
