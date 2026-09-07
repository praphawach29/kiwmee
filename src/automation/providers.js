class MockNotificationProvider {
  constructor(options = {}) {
    this.sent = [];
    this.failTypes = new Set(options.failTypes ?? []);
    this.deliveries = new Map();
  }

  async sendConfirmation(payload) {
    return this.send("booking_confirmation", payload);
  }

  async sendReminder(payload) {
    return this.send("appointment_reminder", payload);
  }

  async sendCancellation(payload) {
    return this.send("booking_cancellation", payload);
  }

  async sendFollowUp(payload) {
    return this.send(payload.followup_type ?? "followup", payload);
  }

  async send(type, payload) {
    if (this.deliveries.has(payload.idempotency_key)) return this.deliveries.get(payload.idempotency_key);
    if (this.failTypes.has(type)) {
      throw new Error(`mock provider failure for ${type}`);
    }

    const result = { type, payload, sent_at: new Date().toISOString() };
    this.sent.push(result);
    if (payload.idempotency_key) this.deliveries.set(payload.idempotency_key, result);
    return result;
  }
}

class ConsoleNotificationProvider {
  constructor() {
    this.deliveryMode = "console";
  }
  async sendConfirmation(payload) {
    return this.log("booking_confirmation", payload);
  }

  async sendReminder(payload) {
    return this.log("appointment_reminder", payload);
  }

  async sendCancellation(payload) {
    return this.log("booking_cancellation", payload);
  }

  async sendFollowUp(payload) {
    return this.log(payload.followup_type ?? "followup", payload);
  }

  async log(type, payload) {
    const result = { type, payload, sent_at: new Date().toISOString() };
    console.log("[notification]", JSON.stringify(result));
    return result;
  }
}

class ShadowNotificationProvider {
  constructor() {
    this.deliveryMode = "shadow";
  }
}

module.exports = {
  ConsoleNotificationProvider,
  MockNotificationProvider,
  ShadowNotificationProvider
};
