// Salon Booking OS v1 - Licensing Errors
const { AppError } = require("../errors");

class FeatureNotEntitledError extends AppError {
  constructor(featureKey) {
    super("FEATURE_NOT_ENTITLED", `Feature "${featureKey}" is not enabled in the current package or subscription.`, 403, {
      feature: featureKey
    });
    this.name = "FeatureNotEntitledError";
    this.featureKey = featureKey;
  }
}

module.exports = { FeatureNotEntitledError };
