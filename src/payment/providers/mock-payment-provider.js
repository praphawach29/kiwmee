// Salon Booking OS v1 - Mock Payment Provider
// Simulates payment gateway operations (Opn, Stripe)

const { PaymentProvider } = require("./payment-provider");

class MockPaymentProvider extends PaymentProvider {
  constructor(options = {}) {
    super();
    this.name = options.name || "mock_gateway";
    this.intents = new Map();
    this.refunds = new Map();
    this.shouldFail = options.shouldFail || false;
  }

  async createPaymentIntent({ paymentId, amount, currency = "THB", idempotencyKey }) {
    if (this.shouldFail) {
      const err = new Error("Mock gateway intent creation failed");
      err.code = "GATEWAY_INTENT_ERROR";
      throw err;
    }

    const intentId = `pi_mock_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const intent = {
      id: intentId,
      paymentId,
      amount,
      currency,
      idempotencyKey,
      status: "requires_payment_method",
      chargeUrl: `https://mock-gateway.local/pay/${intentId}`,
      createdAt: new Date().toISOString()
    };
    this.intents.set(intentId, intent);
    return intent;
  }

  async getPaymentStatus(providerReference) {
    const intent = this.intents.get(providerReference);
    if (!intent) {
      return { status: "not_found" };
    }
    return intent;
  }

  async refund({ paymentId, providerReference, amount, idempotencyKey, reason }) {
    if (this.shouldFail) {
      const err = new Error("Mock gateway refund failed");
      err.code = "GATEWAY_REFUND_ERROR";
      throw err;
    }

    const refundId = `ref_mock_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const refundData = {
      id: refundId,
      paymentId,
      providerReference,
      amount,
      idempotencyKey,
      reason,
      status: "completed",
      completedAt: new Date().toISOString()
    };
    this.refunds.set(refundId, refundData);
    return refundData;
  }

  async verifyWebhook(rawBody, signature) {
    if (signature === "invalid-sig") {
      const err = new Error("Invalid mock webhook signature");
      err.code = "INVALID_SIGNATURE";
      throw err;
    }
    return typeof rawBody === "string" ? JSON.parse(rawBody) : rawBody;
  }
}

module.exports = { MockPaymentProvider };
