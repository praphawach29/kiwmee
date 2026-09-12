// Salon Booking OS v1 - Mock Slip Verification Provider
// Deterministic mock for testing slip verification workflows

const { SlipVerificationProvider } = require("./slip-verification-provider");

const MOCK_SLIP_SCENARIOS = {
  VALID: "VALID",
  AMOUNT_MISMATCH: "AMOUNT_MISMATCH",
  OVERPAYMENT: "OVERPAYMENT",
  RECEIVER_MISMATCH: "RECEIVER_MISMATCH",
  DUPLICATE_TRANSACTION: "DUPLICATE_TRANSACTION",
  INVALID_SLIP: "INVALID_SLIP",
  TIMEOUT: "TIMEOUT"
};

class MockSlipProvider extends SlipVerificationProvider {
  constructor(options = {}) {
    super();
    this.defaultScenario = options.scenario || MOCK_SLIP_SCENARIOS.VALID;
    this.receiverAccount = options.receiverAccount || "0812345678";
    this.authoritative = options.authoritative !== undefined ? options.authoritative : true;
    this.history = [];
  }

  setScenario(scenario) {
    this.defaultScenario = scenario;
  }

  setAuthoritative(authoritative) {
    this.authoritative = authoritative;
  }

  async verifySlip({ slipUrl, slipData, expectedAmount, expectedReceiver, scenarioOverride }) {
    const scenario = scenarioOverride || this.defaultScenario;
    const targetReceiver = expectedReceiver || this.receiverAccount;
    const requestId = `req_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const isAuth = this.authoritative;

    this.history.push({
      requestId,
      scenario,
      expectedAmount,
      expectedReceiver: targetReceiver,
      timestamp: new Date().toISOString()
    });

    switch (scenario) {
      case MOCK_SLIP_SCENARIOS.VALID:
        return {
          verified: true,
          authoritative: isAuth,
          provider: "mock_slip",
          provider_request_id: requestId,
          providerRequestId: requestId,
          provider_status: "verified",
          rawStatus: "verified",
          normalized_result: "success",
          verified_amount: Number(expectedAmount),
          amountSatang: Math.round(Number(expectedAmount) * 100),
          amount: Number(expectedAmount),
          currency: "THB",
          verified_receiver: targetReceiver,
          receiver: { merchantIdentifier: targetReceiver, promptPayIdentifierMasked: targetReceiver, accountName: targetReceiver },
          verified_sender: "0899999999",
          sender: { accountNumberMasked: "0899999999", accountName: "Customer" },
          transactionNamespace: "promptpay_qr",
          transactionReference: `TXN_${Date.now()}`,
          verified_transaction_reference: `TXN_${Date.now()}`,
          verified_transaction_at: new Date().toISOString(),
          transactionAt: new Date().toISOString(),
          reasonCode: "SUCCESS",
          failure_reason_code: null
        };

      case MOCK_SLIP_SCENARIOS.AMOUNT_MISMATCH:
        return {
          provider_request_id: requestId,
          provider_status: "verified_partial",
          normalized_result: "amount_mismatch",
          verified_amount: Number(expectedAmount) > 100 ? Number(expectedAmount) - 100 : Number(expectedAmount) / 2,
          verified_receiver: targetReceiver,
          verified_sender: "0899999999",
          verified_transaction_reference: `TXN_${Date.now()}`,
          verified_transaction_at: new Date().toISOString(),
          failure_reason_code: "PAID_LESS_THAN_DUE"
        };

      case MOCK_SLIP_SCENARIOS.OVERPAYMENT:
        return {
          provider_request_id: requestId,
          provider_status: "verified_overpaid",
          normalized_result: "overpaid",
          verified_amount: Number(expectedAmount) + 200,
          verified_receiver: targetReceiver,
          verified_sender: "0899999999",
          verified_transaction_reference: `TXN_${Date.now()}`,
          verified_transaction_at: new Date().toISOString(),
          failure_reason_code: "PAID_MORE_THAN_DUE"
        };

      case MOCK_SLIP_SCENARIOS.RECEIVER_MISMATCH:
        return {
          provider_request_id: requestId,
          provider_status: "verified",
          normalized_result: "receiver_mismatch",
          verified_amount: Number(expectedAmount),
          verified_receiver: "9999999999", // Different account
          verified_sender: "0899999999",
          verified_transaction_reference: `TXN_${Date.now()}`,
          verified_transaction_at: new Date().toISOString(),
          failure_reason_code: "RECEIVER_NOT_MATCHED"
        };

      case MOCK_SLIP_SCENARIOS.DUPLICATE_TRANSACTION:
        return {
          provider_request_id: requestId,
          provider_status: "duplicate",
          normalized_result: "duplicate",
          verified_amount: Number(expectedAmount),
          verified_receiver: targetReceiver,
          verified_sender: "0899999999",
          verified_transaction_reference: "TXN_DUPLICATE_ALREADY_USED",
          verified_transaction_at: new Date().toISOString(),
          failure_reason_code: "SLIP_ALREADY_REDEEMED"
        };

      case MOCK_SLIP_SCENARIOS.INVALID_SLIP:
        return {
          provider_request_id: requestId,
          provider_status: "unreadable",
          normalized_result: "invalid_slip",
          verified_amount: null,
          verified_receiver: null,
          verified_sender: null,
          verified_transaction_reference: null,
          verified_transaction_at: null,
          failure_reason_code: "QR_CODE_CORRUPTED"
        };

      case MOCK_SLIP_SCENARIOS.TIMEOUT: {
        const error = new Error("Slip verification provider connection timed out");
        error.code = "PROVIDER_TIMEOUT";
        throw error;
      }

      default:
        throw new Error(`Unknown mock slip scenario: ${scenario}`);
    }
  }
}

module.exports = {
  MOCK_SLIP_SCENARIOS,
  MockSlipProvider
};
