// Salon Booking OS v1 - Payment Presentation Abstraction
// Normalizes QR and payment presentation for LINE Flex and omnichannel clients
// Fail-Closed: Never outputs real bank account numbers, credentials, or production QR payloads in Phase E.

class PaymentPresentationProvider {
  /**
   * Creates a normalized presentation contract for client consumption.
   * @param {Object} params
   * @param {string} params.paymentId
   * @param {number} params.amountDueSatang
   * @param {string} params.currency
   * @param {string|Date} params.expiresAt
   * @param {string} [params.businessId]
   * @returns {Promise<Object>}
   */
  async createPaymentPresentation(params) {
    throw new Error("createPaymentPresentation must be implemented by subclass");
  }
}

class MockPaymentPresentationProvider extends PaymentPresentationProvider {
  constructor(options = {}) {
    super();
    this.defaultQrImageUrl = options.qrImageUrl || "https://images.unsplash.com/photo-1563013544-824ae1b704d3?auto=format&fit=crop&w=400&q=80";
    this.defaultInstructions = options.instructions || "เมื่อชำระแล้ว ส่งรูปสลิปในแชทนี้ได้เลย";
  }

  createPaymentPresentationSync({
    paymentId,
    amountDueSatang,
    currency = "THB",
    expiresAt,
    businessId = "default"
  }) {
    const amountNum = typeof amountDueSatang === "number" ? amountDueSatang / 100 : 0;
    const displayAmount = `฿${amountNum.toLocaleString("th-TH", { minimumFractionDigits: 0 })}`;
    const expiresIso = expiresAt instanceof Date ? expiresAt.toISOString() : String(expiresAt || "");

    return {
      type: "mock_qr",
      displayAmount,
      amountDueSatang,
      currency,
      qrImageUrl: this.defaultQrImageUrl,
      paymentInstructions: this.defaultInstructions,
      expiresAt: expiresIso,
      metadata: {
        isTestMock: true,
        businessId
      }
    };
  }

  async createPaymentPresentation(params) {
    return this.createPaymentPresentationSync(params);
  }
}

module.exports = {
  PaymentPresentationProvider,
  MockPaymentPresentationProvider
};
