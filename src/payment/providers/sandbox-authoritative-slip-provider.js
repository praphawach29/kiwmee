// Salon Booking OS v1 - Sandbox Authoritative Slip Provider
// Generic sandbox provider adapter with injected config, fake transport support,
// and deterministic scenarios for authoritative verification testing.

const { AuthoritativeSlipProvider } = require("./authoritative-slip-provider");
const { PAYMENT_REASON_CODES } = require("../reason-codes");
const { SlipTransportError } = require("./slip-provider-transport");

const SANDBOX_SCENARIOS = {
  VALID_AUTHORITATIVE: "VALID_AUTHORITATIVE",
  NON_AUTHORITATIVE_OCR: "NON_AUTHORITATIVE_OCR",
  UNDERPAYMENT: "UNDERPAYMENT",
  OVERPAYMENT: "OVERPAYMENT",
  WRONG_RECEIVER: "WRONG_RECEIVER",
  DUPLICATE_TRANSACTION: "DUPLICATE_TRANSACTION",
  LATE_PAYMENT: "LATE_PAYMENT",
  TRANSACTION_NOT_FOUND: "TRANSACTION_NOT_FOUND",
  TIMEOUT: "TIMEOUT",
  RATE_LIMIT: "RATE_LIMIT",
  PROVIDER_DOWN: "PROVIDER_DOWN",
  AUTH_FAILURE: "AUTH_FAILURE"
};

class SandboxAuthoritativeSlipProvider extends AuthoritativeSlipProvider {
  /**
   * @param {Object} options
   * @param {string} [options.endpoint] - Injected sandbox endpoint
   * @param {string} [options.apiKeyReference] - Injected secret reference key (e.g. env var name)
   * @param {number} [options.timeoutMs] - Injected timeout
   * @param {Object} [options.transport] - Injected SlipProviderTransport or mock transport
   * @param {string} [options.scenario] - Default sandbox scenario
   */
  constructor(options = {}) {
    super({
      capabilities: {
        providerName: "sandbox_authoritative",
        supportsImageUpload: true,
        supportsQrPayload: true,
        supportsTransactionReference: true,
        supportsAmountVerification: true,
        supportsReceiverVerification: true,
        supportsTransactionTime: true,
        supportsBankReference: true,
        supportsSandbox: true,
        supportsWebhook: false,
        ...(options.capabilities || {})
      }
    });

    this.endpoint = options.endpoint || "https://sandbox.bank-slip-verifier.local/v1/verify";
    this.apiKeyReference = options.apiKeyReference || "SLIP_VERIFIER_API_KEY";
    this.timeoutMs = options.timeoutMs || 10000;
    this.transport = options.transport || null;
    this.scenario = options.scenario || SANDBOX_SCENARIOS.VALID_AUTHORITATIVE;
    this.history = [];
  }

  setScenario(scenario) {
    this.scenario = scenario;
  }

  generateScenarioResult(scenario, params = {}) {
    const {
      expectedAmount = 300,
      expectedReceiver = "default",
      now = new Date()
    } = params;

    const nowDate = now instanceof Date ? now : new Date(now);
    const requestId = `req_sbx_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const expAmt = Number(expectedAmount || 0);
    const targetReceiverObj = typeof expectedReceiver === "object" && expectedReceiver !== null
      ? expectedReceiver
      : {
          bankCode: "004", // KBANK
          accountNumberMasked: "xxx-x-xx123-4",
          promptPayIdentifierMasked: "081-xxx-5678",
          merchantIdentifier: typeof expectedReceiver === "string" ? expectedReceiver : "default",
          accountName: "Salon Booking OS"
        };

    let verified = false;
    let authoritative = true;
    let reasonCode = PAYMENT_REASON_CODES.SUCCESS;
    let rawStatus = "COMPLETED";
    let normalizedResult = "success";
    let verifiedAmount = expAmt;
    let verifiedReceiver = { ...targetReceiverObj };
    let transactionRef = `TXN_AUTHORITATIVE_${Date.now()}_${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
    let transactionAt = nowDate.toISOString();

    switch (scenario) {
      case SANDBOX_SCENARIOS.VALID_AUTHORITATIVE:
        verified = true;
        authoritative = true;
        reasonCode = PAYMENT_REASON_CODES.SUCCESS;
        rawStatus = "COMPLETED";
        normalizedResult = "success";
        break;

      case SANDBOX_SCENARIOS.NON_AUTHORITATIVE_OCR:
        // AI / OCR reading is NEVER authoritative
        verified = true;
        authoritative = false;
        reasonCode = PAYMENT_REASON_CODES.NON_AUTHORITATIVE_VERIFICATION;
        rawStatus = "OCR_READING_ONLY";
        normalizedResult = "provider_error"; // Never auto-confirmed
        break;

      case SANDBOX_SCENARIOS.UNDERPAYMENT:
        verified = false;
        authoritative = true;
        verifiedAmount = expAmt > 100 ? expAmt - 100 : expAmt / 2;
        reasonCode = PAYMENT_REASON_CODES.AMOUNT_MISMATCH;
        rawStatus = "AMOUNT_MISMATCH_LESS";
        normalizedResult = "amount_mismatch";
        break;

      case SANDBOX_SCENARIOS.OVERPAYMENT:
        verified = false;
        authoritative = true;
        verifiedAmount = expAmt + 200;
        reasonCode = PAYMENT_REASON_CODES.OVERPAYMENT;
        rawStatus = "AMOUNT_MISMATCH_MORE";
        normalizedResult = "overpaid";
        break;

      case SANDBOX_SCENARIOS.WRONG_RECEIVER:
        verified = false;
        authoritative = true;
        verifiedReceiver = {
          bankCode: "014", // SCB
          accountNumberMasked: "xxx-x-xx999-9",
          promptPayIdentifierMasked: "099-xxx-9999",
          merchantIdentifier: "unauthorized_merchant_999",
          accountName: "Unknown Third Party"
        };
        reasonCode = PAYMENT_REASON_CODES.RECEIVER_MISMATCH;
        rawStatus = "RECEIVER_NOT_MATCHED";
        normalizedResult = "receiver_mismatch";
        break;

      case SANDBOX_SCENARIOS.DUPLICATE_TRANSACTION:
        verified = false;
        authoritative = true;
        transactionRef = "TXN_REUSED_HISTORICAL_REF_001";
        reasonCode = PAYMENT_REASON_CODES.DUPLICATE_TRANSACTION;
        rawStatus = "TRANSACTION_ALREADY_REDEEMED";
        normalizedResult = "duplicate";
        break;

      case SANDBOX_SCENARIOS.LATE_PAYMENT:
        // Payment was genuine and authoritative, but made 2 hours late
        verified = true;
        authoritative = true;
        transactionAt = new Date(nowDate.getTime() + 120 * 60 * 1000).toISOString();
        reasonCode = PAYMENT_REASON_CODES.LATE_PAYMENT_REVIEW;
        rawStatus = "TRANSACTION_FOUND_POST_EXPIRY";
        normalizedResult = "success";
        break;

      case SANDBOX_SCENARIOS.TRANSACTION_NOT_FOUND:
        verified = false;
        authoritative = true;
        verifiedAmount = null;
        transactionRef = null;
        reasonCode = PAYMENT_REASON_CODES.TRANSACTION_NOT_FOUND;
        rawStatus = "NOT_FOUND_AT_BANK";
        normalizedResult = "invalid_slip";
        break;

      default:
        verified = false;
        authoritative = false;
        reasonCode = PAYMENT_REASON_CODES.UNKNOWN_PROVIDER_ERROR;
        rawStatus = "UNKNOWN_SCENARIO";
        normalizedResult = "provider_error";
    }

    const amountSatang = verifiedAmount !== null ? Math.round(Number(verifiedAmount) * 100) : 0;

    return {
      // Required Provider-Neutral Contract (Phase F)
      verified,
      authoritative,
      provider: "sandbox_authoritative",
      providerRequestId: requestId,
      transactionNamespace: "promptpay_qr",
      transactionReference: transactionRef,
      amountSatang,
      amount: verifiedAmount,
      currency: "THB",
      receiver: verifiedReceiver,
      sender: {
        bankCode: "002", // BBL
        accountNumberMasked: "xxx-x-xx888-8",
        accountName: "Customer Payer"
      },
      transactionAt,
      reasonCode,
      rawStatus,

      // Database persistence backward compatibility
      normalized_result: normalizedResult,
      verified_amount: verifiedAmount,
      verified_receiver: verifiedReceiver?.merchantIdentifier || verifiedReceiver?.accountNumberMasked || null,
      verified_sender: "xxx-x-xx888-8",
      verified_transaction_reference: transactionRef,
      verified_transaction_at: transactionAt,
      provider_status: rawStatus,
      provider_request_id: requestId,
      failure_reason_code: verified ? null : reasonCode
    };
  }

  async verifySlip(params) {
    const {
      slipData,
      slipUrl,
      expectedAmount,
      expectedReceiver,
      expectedDate,
      scenarioOverride,
      now = new Date()
    } = params;

    const scenario = scenarioOverride || this.scenario;
    const nowDate = now instanceof Date ? now : new Date(now);
    const requestId = `req_sbx_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

    this.history.push({
      requestId,
      scenario,
      expectedAmount,
      expectedReceiver,
      timestamp: nowDate.toISOString()
    });

    // Simulate simulated network failure scenarios
    if (scenario === SANDBOX_SCENARIOS.TIMEOUT) {
      const err = new SlipTransportError("Connection to sandbox verifier timed out", PAYMENT_REASON_CODES.PROVIDER_TIMEOUT, 408, true);
      err.code = PAYMENT_REASON_CODES.PROVIDER_TIMEOUT;
      throw err;
    }
    if (scenario === SANDBOX_SCENARIOS.RATE_LIMIT) {
      const err = new SlipTransportError("Too many verification requests", PAYMENT_REASON_CODES.RATE_LIMITED, 429, true);
      err.code = PAYMENT_REASON_CODES.RATE_LIMITED;
      throw err;
    }
    if (scenario === SANDBOX_SCENARIOS.PROVIDER_DOWN) {
      const err = new SlipTransportError("Sandbox provider gateway unavailable", PAYMENT_REASON_CODES.PROVIDER_UNAVAILABLE, 503, true);
      err.code = PAYMENT_REASON_CODES.PROVIDER_UNAVAILABLE;
      throw err;
    }
    if (scenario === SANDBOX_SCENARIOS.AUTH_FAILURE) {
      const err = new SlipTransportError("Invalid API key reference", PAYMENT_REASON_CODES.AUTHENTICATION_FAILED, 401, false);
      err.code = PAYMENT_REASON_CODES.AUTHENTICATION_FAILED;
      throw err;
    }

    return this.generateScenarioResult(scenario, params);
  }
}

module.exports = {
  SANDBOX_SCENARIOS,
  SandboxAuthoritativeSlipProvider
};
