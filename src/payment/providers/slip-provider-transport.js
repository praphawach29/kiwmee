// Salon Booking OS v1 - Slip Provider HTTP Transport Abstraction
// Handles HTTP execution, timeouts, bounded retries, idempotency-safe request handling,
// and network status normalization. Domain layers remain completely agnostic of HTTP details.

const { PAYMENT_REASON_CODES } = require("../reason-codes");

class SlipTransportError extends Error {
  constructor(message, code, status = null, isRetryable = false, attempts = 1) {
    super(message);
    this.name = "SlipTransportError";
    this.code = code;
    this.status = status;
    this.isRetryable = isRetryable;
    this.retryable = isRetryable;
    this.attempts = attempts;
  }
}

class SlipProviderTransport {
  constructor(options = {}) {
    this.connectTimeoutMs = options.connectTimeoutMs || 5000;
    this.requestTimeoutMs = options.requestTimeoutMs || 10000;
    this.maxRetries = options.maxRetries ?? 2;
    this.baseBackoffMs = options.baseBackoffMs || 200;
    this.supportsRequestIdempotency = options.supportsRequestIdempotency === true;
    this.idempotencyHeaderName = options.idempotencyHeaderName || "Idempotency-Key";
    this.fetchFn = options.fetchFn || globalThis.fetch;
  }

  isRetryableStatusCode(status) {
    return [408, 429, 502, 503, 504].includes(status);
  }

  normalizeError(error, status = null, isIdempotencySafe = true, attempts = 1) {
    if (error instanceof SlipTransportError) return error;

    const msg = error?.message || "Unknown transport error";
    const isTimeout = error?.name === "AbortError" || msg.toLowerCase().includes("timeout") || msg.toLowerCase().includes("timed out");
    const isRetryableStatus = this.isRetryableStatusCode(status);

    // Hard invariant: if request is not guaranteed idempotent, transient server errors or timeouts
    // occurring after dispatch MUST NOT be blindly retried and must return PROVIDER_UNCERTAIN_RESULT.
    if (!isIdempotencySafe && (isRetryableStatus || isTimeout)) {
      return new SlipTransportError(
        `Provider request status uncertain (${msg}); automatic retry disallowed without verified request idempotency`,
        PAYMENT_REASON_CODES.PROVIDER_UNCERTAIN_RESULT,
        status,
        false,
        attempts
      );
    }

    if (isTimeout) {
      return new SlipTransportError("Request timed out", PAYMENT_REASON_CODES.PROVIDER_TIMEOUT, status, true, attempts);
    }
    if (status === 400 || status === 404 || status === 422) {
      return new SlipTransportError(`Bad request to provider: ${status}`, PAYMENT_REASON_CODES.INVALID_SLIP, status, false, attempts);
    }
    if (status === 401 || status === 403) {
      return new SlipTransportError("Authentication failed with slip provider", PAYMENT_REASON_CODES.AUTHENTICATION_FAILED, status, false, attempts);
    }
    if (status === 429) {
      return new SlipTransportError("Provider rate limit reached", PAYMENT_REASON_CODES.RATE_LIMITED, status, true, attempts);
    }
    if (status && status >= 500) {
      return new SlipTransportError(`Provider server error: ${status}`, PAYMENT_REASON_CODES.PROVIDER_UNAVAILABLE, status, true, attempts);
    }
    if (msg.includes("ECONNREFUSED") || msg.includes("ENOTFOUND")) {
      return new SlipTransportError("Provider connection unavailable", PAYMENT_REASON_CODES.PROVIDER_UNAVAILABLE, status, true, attempts);
    }

    return new SlipTransportError(msg, PAYMENT_REASON_CODES.UNKNOWN_PROVIDER_ERROR, status, false, attempts);
  }

  async request(method, url, options = {}) {
    const {
      headers = {},
      body = null,
      timeoutMs = this.requestTimeoutMs,
      requestId = null,
      idempotencyKey = null
    } = options;

    const effectiveIdempotencyKey = idempotencyKey || requestId;
    const supportsIdempotency = options.supportsRequestIdempotency !== undefined
      ? options.supportsRequestIdempotency === true
      : this.supportsRequestIdempotency === true;

    const isGetOrSafe = ["GET", "HEAD", "OPTIONS"].includes(method.toUpperCase());
    const isIdempotencySafe = isGetOrSafe || (supportsIdempotency && Boolean(effectiveIdempotencyKey));

    // Caller can explicitly set retrySafe, but it can never violate the idempotency safety rule for POST
    const retrySafe = options.retrySafe !== undefined
      ? (options.retrySafe && isIdempotencySafe)
      : isIdempotencySafe;

    const maxAttempts = retrySafe ? (1 + this.maxRetries) : 1;
    let lastError = null;

    const effectiveHeaders = { ...headers };
    if (effectiveIdempotencyKey) {
      const headerName = options.idempotencyHeaderName || this.idempotencyHeaderName;
      effectiveHeaders[headerName] = effectiveIdempotencyKey;
    }

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const fetchOptions = {
          method,
          headers: {
            "Accept": "application/json",
            ...effectiveHeaders
          },
          signal: controller.signal
        };

        if (body) {
          if (typeof body === "object" && !(body instanceof Buffer) && !(body instanceof Uint8Array)) {
            fetchOptions.headers["Content-Type"] = "application/json";
            fetchOptions.body = JSON.stringify(body);
          } else {
            fetchOptions.body = body;
          }
        }

        const response = await this.fetchFn(url, fetchOptions);
        clearTimeout(timer);

        if (!response.ok) {
          const isRetryable = this.isRetryableStatusCode(response.status);
          const err = this.normalizeError(
            new Error(`HTTP ${response.status} ${response.statusText}`),
            response.status,
            isIdempotencySafe,
            attempt
          );

          if (isRetryable && retrySafe && attempt < maxAttempts) {
            let delay = this.baseBackoffMs * Math.pow(2, attempt - 1);
            if (response.status === 429) {
              const retryAfterHeader = response.headers?.get?.("retry-after");
              if (retryAfterHeader) {
                const parsedSec = parseInt(retryAfterHeader, 10);
                if (!isNaN(parsedSec) && parsedSec > 0) {
                  delay = Math.min(parsedSec * 1000, 5000); // capped at 5s
                }
              }
            }
            await new Promise((resolve) => setTimeout(resolve, delay));
            lastError = err;
            continue;
          }
          throw err;
        }

        let data;
        const contentType = response.headers?.get?.("content-type") || "";
        if (contentType.includes("application/json")) {
          if (typeof response.json === "function") {
            data = await response.json();
          } else {
            const text = await response.text();
            data = JSON.parse(text);
          }
        } else if (typeof response.text === "function") {
          data = await response.text();
        } else {
          data = response.data;
        }

        return {
          status: response.status,
          headers: response.headers,
          data,
          attempts: attempt
        };

      } catch (err) {
        clearTimeout(timer);
        const normalized = this.normalizeError(err, err.status || null, isIdempotencySafe, attempt);

        if (normalized.isRetryable && retrySafe && attempt < maxAttempts) {
          const delay = this.baseBackoffMs * Math.pow(2, attempt - 1);
          await new Promise((resolve) => setTimeout(resolve, delay));
          lastError = normalized;
          continue;
        }
        throw normalized;
      }
    }

    throw lastError || new SlipTransportError("Request failed after retries", PAYMENT_REASON_CODES.PROVIDER_UNAVAILABLE, null, false, maxAttempts);
  }

  async post(url, body, options = {}) {
    return this.request("POST", url, { ...options, body });
  }

  async get(url, options = {}) {
    return this.request("GET", url, { ...options });
  }
}

module.exports = {
  SlipTransportError,
  SlipProviderTransport
};
