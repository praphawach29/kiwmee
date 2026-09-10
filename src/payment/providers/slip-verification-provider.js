// Salon Booking OS v1 - Slip Verification Provider Interface
// Abstract base class for bank transfer slip verification providers

class SlipVerificationProvider {
  /**
   * Verifies a bank transfer slip against expected payment parameters.
   * 
   * @param {Object} params
   * @param {string|Buffer} [params.slipData] - Binary or base64 representation of slip
   * @param {string} [params.slipUrl] - URL or object storage reference
   * @param {number} params.expectedAmount - Expected payment amount in THB
   * @param {string} params.expectedReceiver - Expected receiver account/PromptPay identifier
   * @param {string} [params.expectedDate] - Expected transaction date
   * @returns {Promise<Object>} Normalized verification result
   */
  async verifySlip(params) {
    throw new Error("verifySlip must be implemented by slip verification provider");
  }
}

module.exports = { SlipVerificationProvider };
