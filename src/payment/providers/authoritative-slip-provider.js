// Salon Booking OS v1 - Authoritative Slip Provider Base & Capability Model
// Defines provider metadata, capability contract, and required baseline for auto-confirmation.

const { SlipVerificationProvider } = require("./slip-verification-provider");

const DEFAULT_PROVIDER_CAPABILITIES = {
  providerName: "authoritative_base",
  supportsImageUpload: true,
  supportsQrPayload: true,
  supportsTransactionReference: true,
  supportsAmountVerification: true,
  supportsReceiverVerification: true,
  supportsTransactionTime: true,
  supportsBankReference: true,
  supportsSandbox: true,
  supportsWebhook: false
};

/**
 * Validates whether a provider's declared capabilities satisfy the strict minimum
 * required by the domain for automated payment confirmation.
 */
function hasRequiredAutoConfirmCapabilities(capabilities) {
  if (!capabilities) return false;
  return Boolean(
    capabilities.supportsTransactionReference === true &&
    capabilities.supportsAmountVerification === true &&
    capabilities.supportsReceiverVerification === true &&
    capabilities.supportsTransactionTime === true
  );
}

class AuthoritativeSlipProvider extends SlipVerificationProvider {
  constructor(options = {}) {
    super();
    this.capabilities = {
      ...DEFAULT_PROVIDER_CAPABILITIES,
      ...(options.capabilities || {})
    };
  }

  getCapabilities() {
    return { ...this.capabilities };
  }

  isAuthoritative() {
    return true;
  }
}

module.exports = {
  DEFAULT_PROVIDER_CAPABILITIES,
  hasRequiredAutoConfirmCapabilities,
  AuthoritativeSlipProvider
};
