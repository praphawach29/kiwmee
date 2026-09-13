// Salon Booking OS v1 - EasySlip v2 Provider Adapter
// Test / Manual-Review Adapter for EasySlip v2 Bank Verification API (POST /v2/verify/bank)
//
// Hard Security & Architecture Invariants (Phase H):
// 1. Authoritative flag defaults strictly to FALSE (EASYSLIP_AUTHORITATIVE_CONFIRMED=false)
//    until verified banking source-of-truth semantics are proven.
// 2. Safe request dispatch: EasySlip does not document client-supplied Idempotency-Key headers.
//    supportsRequestIdempotency is strictly FALSE; no blind transient HTTP retries after POST dispatch.
// 3. Inputs supported: deterministic QR payload (primary) or image buffer / base64 / URL (fallback).
// 4. Exact amount conversion via deterministic toSatang(amountInBaht).
// 5. Explicit error code normalization to Salon Booking OS domain reason codes.
// 6. Zero secret leakage in payloads or payment_attempts.

const { AuthoritativeSlipProvider } = require("./authoritative-slip-provider");
const { SlipProviderTransport, SlipTransportError } = require("./slip-provider-transport");
const { PAYMENT_REASON_CODES } = require("../reason-codes");
const { toSatang } = require("../money");

const DEFAULT_EASYSLIP_BASE_URL = "https://api.easyslip.com";
const DEFAULT_EASYSLIP_ENDPOINT = "/v2/verify/bank";

/**
 * Normalized vendor reason codes mapping for EasySlip v2 official error codes.
 * Prevents raw vendor error structures from leaking to customer or core domain.
 */
const EASYSLIP_ERROR_MAPPING = {
  VALIDATION_ERROR: PAYMENT_REASON_CODES.INVALID_SLIP,
  SLIP_NOT_FOUND: PAYMENT_REASON_CODES.TRANSACTION_NOT_FOUND,
  SLIP_PENDING: "PROVIDER_PENDING",
  QUOTA_EXCEEDED: PAYMENT_REASON_CODES.PROVIDER_UNAVAILABLE,
  INVALID_API_KEY: PAYMENT_REASON_CODES.AUTHENTICATION_FAILED,
  IP_NOT_ALLOWED: PAYMENT_REASON_CODES.AUTHENTICATION_FAILED,
  RATE_LIMIT_EXCEEDED: PAYMENT_REASON_CODES.RATE_LIMITED,
  API_SERVER_ERROR: PAYMENT_REASON_CODES.PROVIDER_UNAVAILABLE,
  INTERNAL_SERVER_ERROR: PAYMENT_REASON_CODES.PROVIDER_UNAVAILABLE
};

/**
 * Maps an EasySlip error code or HTTP status to canonical domain reason code.
 */
function normalizeEasySlipErrorCode(errorCode, httpStatus = null) {
  if (errorCode && EASYSLIP_ERROR_MAPPING[errorCode]) {
    return EASYSLIP_ERROR_MAPPING[errorCode];
  }
  if (httpStatus === 401) return PAYMENT_REASON_CODES.AUTHENTICATION_FAILED;
  if (httpStatus === 403) return PAYMENT_REASON_CODES.AUTHENTICATION_FAILED;
  if (httpStatus === 404) return PAYMENT_REASON_CODES.TRANSACTION_NOT_FOUND;
  if (httpStatus === 429) return PAYMENT_REASON_CODES.RATE_LIMITED;
  if (httpStatus && httpStatus >= 500) return PAYMENT_REASON_CODES.PROVIDER_UNAVAILABLE;
  return PAYMENT_REASON_CODES.UNKNOWN_PROVIDER_ERROR;
}

class EasySlipV2Provider extends AuthoritativeSlipProvider {
  /**
   * @param {Object} [options]
   * @param {string} [options.baseUrl] - Base API URL (defaults to https://api.easyslip.com)
   * @param {string} [options.endpoint] - Verification path (defaults to /v2/verify/bank)
   * @param {string} [options.apiKey] - Injected API key (if available from secure env)
   * @param {string} [options.apiKeyReference] - Environment variable name containing API key
   * @param {boolean} [options.authoritativeConfirmed=false] - Whether banking clearinghouse source of truth is proven
   * @param {Object} [options.transport] - Injected SlipProviderTransport or mock
   * @param {number} [options.timeoutMs=10000] - Request timeout in milliseconds
   */
  constructor(options = {}) {
    super({
      capabilities: {
        providerName: "easyslip_v2",
        supportsImageUpload: true,
        supportsQrPayload: true,
        supportsTransactionReference: true,
        supportsAmountVerification: true,
        supportsReceiverVerification: true,
        supportsTransactionTime: true,
        supportsBankReference: true,
        supportsSandbox: false, // Phase G finding: no dedicated sandbox simulator endpoint documented
        supportsWebhook: false,
        supportsDuplicateCheck: true,
        ...(options.capabilities || {})
      }
    });

    this.baseUrl = (options.baseUrl || process.env.EASYSLIP_BASE_URL || DEFAULT_EASYSLIP_BASE_URL).replace(/\/$/, "");
    this.endpoint = options.endpoint || DEFAULT_EASYSLIP_ENDPOINT;
    this.apiKeyReference = options.apiKeyReference || "EASYSLIP_API_KEY";
    this.apiKey = options.apiKey !== undefined ? options.apiKey : (process.env[this.apiKeyReference] || null);

    // Hard Rule: Authoritative defaults to false in Phase H unless proven by contractual / clearinghouse evidence.
    // Client-side config cannot bypass this domain invariant without explicit evidence.
    this.authoritativeConfirmed = options.authoritativeConfirmed === true ||
      process.env.EASYSLIP_AUTHORITATIVE_CONFIRMED === "true";

    this.timeoutMs = options.timeoutMs || 10000;

    // Transport configuration:
    // IMPORTANT: EasySlip v2 does NOT document a client-supplied Idempotency-Key header.
    // supportsRequestIdempotency is strictly false to prevent blind POST retries.
    this.transport = options.transport || new SlipProviderTransport({
      requestTimeoutMs: this.timeoutMs,
      maxRetries: 0, // No transient retries after dispatch without verified idempotency
      supportsRequestIdempotency: false
    });
  }

  /**
   * Overrides base isAuthoritative():
   * Phase H default MUST be false unless authoritative source is strictly confirmed.
   */
  isAuthoritative() {
    return Boolean(this.authoritativeConfirmed);
  }

  /**
   * Builds the official EasySlip v2 request body.
   * Supports: payload (QR string, preferred) OR image buffer / base64 string / URL.
   *
   * @param {Object} params
   * @param {string} [params.payload] - Raw PromptPay / Thai QR payload string
   * @param {Buffer|Uint8Array} [params.image] - Binary image file buffer
   * @param {string} [params.base64] - Base64 Data URI string
   * @param {string} [params.url] - Public URL to slip image
   * @param {number} [params.matchAmount] - Expected amount in THB for secondary validation
   * @param {boolean} [params.checkDuplicate=true] - Enable EasySlip server-side duplicate detection
   * @param {boolean} [params.matchAccount=false] - Secondary account matching flag
   * @returns {Object} EasySlip request body
   */
  buildRequestBody({ payload, image, base64, url, matchAmount, checkDuplicate = true, matchAccount = false }) {
    const body = {
      checkDuplicate: Boolean(checkDuplicate)
    };

    if (payload && typeof payload === "string" && payload.trim().length > 0) {
      body.payload = payload.trim();
    } else if (base64 && typeof base64 === "string") {
      body.base64 = base64;
    } else if (url && typeof url === "string") {
      body.url = url;
    } else if (image && (Buffer.isBuffer(image) || image instanceof Uint8Array)) {
      // Data URI format with proper MIME detection from magic bytes
      const buf = Buffer.from(image);
      let mime = "image/jpeg";
      if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) {
        mime = "image/png";
      }
      const b64 = buf.toString("base64");
      body.base64 = `data:${mime};base64,${b64}`;
    } else {
      throw new Error("EasySlip v2 request requires one of: payload, image, base64, or url");
    }

    if (matchAmount !== undefined && matchAmount !== null) {
      const amtNum = Number(matchAmount);
      if (Number.isFinite(amtNum) && amtNum > 0) {
        body.matchAmount = amtNum;
      }
    }

    // Secondary matching only: do not use as financial source of truth
    if (matchAccount) {
      body.matchAccount = true;
    }

    return body;
  }

  /**
   * Normalizes official EasySlip v2 API response into Salon Booking OS verification contract.
   *
   * @param {Object} rawResponse - Parsed JSON response from EasySlip v2
   * @param {number} [httpStatus=200] - HTTP status code
   * @param {string} [localRequestId] - Internal correlation ID
   * @returns {Object} Normalized verification result
   */
  normalizeResponse(rawResponse, httpStatus = 200, localRequestId = null) {
    const isHttpOk = httpStatus >= 200 && httpStatus < 300;
    const vendorStatus = rawResponse?.status;
    const data = rawResponse?.data || {};
    const rawSlip = data.rawSlip || {};

    // Check for explicit error responses
    if (!isHttpOk || vendorStatus === "error" || rawResponse?.code) {
      const vendorErrorCode = rawResponse?.code || data?.code || "UNKNOWN_ERROR";
      const normalizedReason = normalizeEasySlipErrorCode(vendorErrorCode, httpStatus);

      return {
        verified: false,
        authoritative: this.isAuthoritative(),
        provider: "easyslip_v2",
        providerRequestId: localRequestId || null,
        provider_request_id: localRequestId || null,
        provider_status: "failed",
        rawStatus: vendorErrorCode,
        normalized_result: vendorErrorCode === "SLIP_PENDING" ? "slip_pending" : "provider_error",
        amountSatang: 0,
        currency: "THB",
        transactionNamespace: "easyslip_th_bank",
        transactionReference: null,
        receiver: null,
        sender: null,
        transactionAt: null,
        isDuplicate: Boolean(data.isDuplicate),
        reasonCode: normalizedReason,
        failure_reason_code: normalizedReason,
        rawResponse: null // Never leak raw response externally
      };
    }

    // Success response parsing
    const transRef = rawSlip.transRef ? String(rawSlip.transRef).trim() : null;
    const decimalAmount = rawSlip.amount?.amount ?? rawResponse?.amountInSlip ?? null;

    let amountSatang = 0;
    if (decimalAmount !== null && decimalAmount !== undefined) {
      try {
        amountSatang = toSatang(decimalAmount);
      } catch {
        amountSatang = 0;
      }
    }

    const currency = rawSlip.amount?.local?.currency || "THB";
    const transactionAt = rawSlip.date ? new Date(rawSlip.date).toISOString() : null;

    // Receiver identity extraction
    const receiverBankCode = rawSlip.receiver?.bank?.id ? String(rawSlip.receiver.bank.id).trim() : null;
    const receiverAccountMasked = rawSlip.receiver?.account?.bank?.account
      ? String(rawSlip.receiver.account.bank.account).trim()
      : null;
    const receiverProxyType = rawSlip.receiver?.account?.proxy?.type || null;
    const receiverProxyAccount = rawSlip.receiver?.account?.proxy?.account
      ? String(rawSlip.receiver.account.proxy.account).trim()
      : null;
    const receiverName = rawSlip.receiver?.account?.name?.th ||
      rawSlip.receiver?.account?.name?.en ||
      null;

    const receiverObj = (receiverBankCode || receiverAccountMasked || receiverProxyAccount || receiverName)
      ? {
          bankCode: receiverBankCode,
          accountNumber: receiverAccountMasked,
          accountNumberMasked: receiverAccountMasked,
          proxyType: receiverProxyType,
          proxyValue: receiverProxyAccount,
          promptPayIdentifierMasked: receiverProxyAccount,
          accountName: receiverName,
          matchedAccount: data.matchedAccount || null
        }
      : null;

    // Sender identity extraction
    const senderBankCode = rawSlip.sender?.bank?.id ? String(rawSlip.sender.bank.id).trim() : null;
    const senderAccountMasked = rawSlip.sender?.account?.bank?.account
      ? String(rawSlip.sender.account.bank.account).trim()
      : null;
    const senderName = rawSlip.sender?.account?.name?.th ||
      rawSlip.sender?.account?.name?.en ||
      null;

    const senderObj = (senderBankCode || senderAccountMasked || senderName)
      ? {
          bankCode: senderBankCode,
          accountNumber: senderAccountMasked,
          accountNumberMasked: senderAccountMasked,
          accountName: senderName
        }
      : null;

    const isDuplicate = Boolean(data.isDuplicate);
    const verified = Boolean(transRef && amountSatang > 0 && !isDuplicate);

    return {
      verified,
      authoritative: this.isAuthoritative(),
      provider: "easyslip_v2",
      // EasySlip v2 does not expose an external request/correlation ID in data; use local correlation ID
      providerRequestId: localRequestId || null,
      provider_request_id: localRequestId || null,
      provider_status: isDuplicate ? "duplicate" : "verified",
      rawStatus: "SUCCESS",
      normalized_result: isDuplicate ? "duplicate" : (verified ? "success" : "invalid_slip"),
      amountSatang,
      verified_amount: amountSatang > 0 ? amountSatang / 100 : null,
      amount: amountSatang > 0 ? amountSatang / 100 : null,
      currency,
      transactionNamespace: "easyslip_th_bank",
      transactionReference: transRef,
      verified_transaction_reference: transRef,
      receiver: receiverObj,
      verified_receiver: receiverObj,
      sender: senderObj,
      verified_sender: senderObj,
      transactionAt,
      verified_transaction_at: transactionAt,
      isDuplicate,
      isAmountMatched: data.isAmountMatched ?? null,
      reasonCode: isDuplicate ? PAYMENT_REASON_CODES.DUPLICATE_TRANSACTION : (verified ? PAYMENT_REASON_CODES.SUCCESS : PAYMENT_REASON_CODES.INVALID_SLIP),
      failure_reason_code: isDuplicate ? PAYMENT_REASON_CODES.DUPLICATE_TRANSACTION : (verified ? null : PAYMENT_REASON_CODES.INVALID_SLIP)
    };
  }

  /**
   * Verifies slip using EasySlip v2 API.
   *
   * @param {Object} params
   * @param {string} [params.payload] - Raw QR payload string
   * @param {Buffer} [params.slipData] - Binary image file buffer
   * @param {string} [params.slipUrl] - URL to slip image
   * @param {number} params.expectedAmount - Expected amount in THB
   * @param {string|Object} params.expectedReceiver - Expected receiver account/business ID
   * @returns {Promise<Object>} Normalized verification result
   */
  async verifySlip({ payload, slipData, slipUrl, expectedAmount, expectedReceiver }) {
    const localRequestId = `es_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const url = `${this.baseUrl}${this.endpoint}`;

    if (!this.apiKey) {
      // Hard fail closed when API key is missing
      const err = new SlipTransportError(
        "EasySlip API key is not configured (LIVE_TRIAL_NOT_EXECUTED_NO_CREDENTIAL)",
        PAYMENT_REASON_CODES.AUTHENTICATION_FAILED,
        401,
        false
      );
      throw err;
    }

    const requestBody = this.buildRequestBody({
      payload,
      image: slipData,
      url: slipUrl,
      matchAmount: expectedAmount,
      checkDuplicate: true,
      matchAccount: false
    });

    const headers = {
      "Authorization": `Bearer ${this.apiKey}`,
      "Content-Type": "application/json",
      "Accept": "application/json"
    };

    try {
      const response = await this.transport.request("POST", url, {
        headers,
        body: requestBody,
        timeoutMs: this.timeoutMs,
        requestId: localRequestId,
        supportsRequestIdempotency: false // Strict invariant: no blind retries after dispatch
      });

      return this.normalizeResponse(response.data, response.status, localRequestId);
    } catch (err) {
      if (err instanceof SlipTransportError) {
        // If transport normalized an uncertain result or timeout
        throw err;
      }
      // Re-throw with normalized error code
      const normalizedCode = normalizeEasySlipErrorCode(err.code || err.message, err.status || null);
      throw new SlipTransportError(err.message, normalizedCode, err.status || null, false);
    }
  }
}

module.exports = {
  DEFAULT_EASYSLIP_BASE_URL,
  DEFAULT_EASYSLIP_ENDPOINT,
  EASYSLIP_ERROR_MAPPING,
  normalizeEasySlipErrorCode,
  EasySlipV2Provider
};
