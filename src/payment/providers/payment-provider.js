// Salon Booking OS v1 - Payment Gateway Provider Interface
// Abstract base class for payment gateway integrations (Opn, Stripe, etc.)

class PaymentProvider {
  /**
   * Creates a payment intent or checkout session.
   * @param {Object} params
   * @param {string} params.paymentId
   * @param {number} params.amount
   * @param {string} params.currency
   * @param {string} params.idempotencyKey
   * @returns {Promise<Object>}
   */
  async createPaymentIntent(params) {
    throw new Error("createPaymentIntent must be implemented by payment provider");
  }

  /**
   * Retrieves the current payment status from the gateway.
   * @param {string} providerReference
   * @returns {Promise<Object>}
   */
  async getPaymentStatus(providerReference) {
    throw new Error("getPaymentStatus must be implemented by payment provider");
  }

  /**
   * Initiates a refund for a completed payment.
   * @param {Object} params
   * @param {string} params.paymentId
   * @param {string} params.providerReference
   * @param {number} params.amount
   * @param {string} params.idempotencyKey
   * @param {string} params.reason
   * @returns {Promise<Object>}
   */
  async refund(params) {
    throw new Error("refund must be implemented by payment provider");
  }

  /**
   * Verifies and decodes an incoming webhook payload.
   * @param {string|Buffer} rawBody
   * @param {string} signature
   * @returns {Promise<Object>}
   */
  async verifyWebhook(rawBody, signature) {
    throw new Error("verifyWebhook must be implemented by payment provider");
  }
}

module.exports = { PaymentProvider };
