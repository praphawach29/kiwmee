// Salon Booking OS v1 - Receiver Matcher
// Strict multi-attribute receiver matching model for bank transfer & PromptPay slips.
// Never relies on accountName string alone.

const RECEIVER_MATCH_STATUS = {
  MATCH: "MATCH",
  MISMATCH: "MISMATCH",
  INSUFFICIENT_DATA: "INSUFFICIENT_DATA"
};

/**
 * Normalizes an account number or PromptPay identifier by stripping non-alphanumeric characters.
 */
function cleanIdentifier(val) {
  if (!val) return "";
  return String(val).replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
}

/**
 * Compares two masked identifiers (e.g. "xxx-x-xx123-4" and "xxx-x-xx123-4").
 * Extracts unmasked suffix/characters to verify alignment.
 */
function maskedIdentifiersMatch(masked1, masked2) {
  const s1 = String(masked1 || "").trim();
  const s2 = String(masked2 || "").trim();
  if (!s1 || !s2) return false;
  if (s1.toLowerCase() === s2.toLowerCase()) return true;

  const hasMask1 = /[xX*]/.test(s1);
  const hasMask2 = /[xX*]/.test(s2);

  if (hasMask1 || hasMask2) {
    const pattern = hasMask1 ? s1 : s2;
    const target = hasMask1 ? s2 : s1;

    const cleanPattern = pattern.replace(/[^0-9a-zA-Z*xX]/g, "");
    const cleanTarget = target.replace(/[^0-9a-zA-Z]/g, "");

    const regexStr = "^" + cleanPattern.replace(/[xX*]+/g, ".*") + "$";
    try {
      const regex = new RegExp(regexStr, "i");
      if (regex.test(cleanTarget)) return true;
    } catch {
      // fallback
    }
  }

  const d1 = s1.replace(/[^0-9]/g, "");
  const d2 = s2.replace(/[^0-9]/g, "");
  if (d1 && d2 && d1 === d2) return true;
  return false;
}

class ReceiverMatcher {
  /**
   * Matches expected merchant receiver parameters against normalized receiver from provider.
   * 
   * @param {Object|string} expected - Expected receiver identity or identifier
   * @param {Object|string} verified - Verified receiver identity from provider
   * @returns {{ status: "MATCH" | "MISMATCH" | "INSUFFICIENT_DATA", reason: string }}
   */
  static match(expected, verified) {
    if (!expected || !verified) {
      return {
        status: RECEIVER_MATCH_STATUS.INSUFFICIENT_DATA,
        reason: "Missing expected or verified receiver data"
      };
    }

    // Convert string inputs to normalized objects
    const expObj = typeof expected === "string"
      ? { merchantIdentifier: expected, promptPayIdentifierMasked: expected, accountName: expected }
      : expected;

    const verObj = typeof verified === "string"
      ? { merchantIdentifier: verified, promptPayIdentifierMasked: verified, accountName: verified }
      : verified;

    let strongComparisonEvaluated = false;

    // 1. Check Merchant Identifier (Strongest)
    const expMerchant = cleanIdentifier(expObj.merchantIdentifier);
    const verMerchant = cleanIdentifier(verObj.merchantIdentifier);
    if (expMerchant && verMerchant) {
      strongComparisonEvaluated = true;
      if (expMerchant === verMerchant) {
        return { status: RECEIVER_MATCH_STATUS.MATCH, reason: "Merchant identifier matched" };
      }
      return { status: RECEIVER_MATCH_STATUS.MISMATCH, reason: "Merchant identifier mismatch" };
    }

    // 2. Check PromptPay Identifier (Strong)
    const expPP = cleanIdentifier(expObj.promptPayIdentifierMasked || expObj.promptpay);
    const verPP = cleanIdentifier(verObj.promptPayIdentifierMasked || verObj.promptpay);
    if (expPP && verPP) {
      strongComparisonEvaluated = true;
      if (expPP === verPP || maskedIdentifiersMatch(expPP, verPP)) {
        return { status: RECEIVER_MATCH_STATUS.MATCH, reason: "PromptPay identifier matched" };
      }
      return { status: RECEIVER_MATCH_STATUS.MISMATCH, reason: "PromptPay identifier mismatch" };
    }

    // 3. Check Bank Code + Account Number (Strong)
    const expBank = cleanIdentifier(expObj.bankCode);
    const verBank = cleanIdentifier(verObj.bankCode);
    const expAcc = cleanIdentifier(expObj.accountNumberMasked || expObj.accountNumber);
    const verAcc = cleanIdentifier(verObj.accountNumberMasked || verObj.accountNumber);

    if (expAcc && verAcc) {
      strongComparisonEvaluated = true;
      const bankMatches = !expBank || !verBank || expBank === verBank;
      const accMatches = expAcc === verAcc || maskedIdentifiersMatch(expAcc, verAcc);

      if (bankMatches && accMatches) {
        return { status: RECEIVER_MATCH_STATUS.MATCH, reason: "Bank account matched" };
      }
      return { status: RECEIVER_MATCH_STATUS.MISMATCH, reason: "Bank account or code mismatch" };
    }

    // 4. Secondary fallback: Account Name string
    // Architectural Invariant: Never auto-confirm based on account name similarity alone!
    const expName = String(expObj.accountName || "").trim().toLowerCase();
    const verName = String(verObj.accountName || "").trim().toLowerCase();

    if (expName && verName) {
      // If strong identifiers were evaluated and didn't match, do not override
      if (strongComparisonEvaluated) {
        return { status: RECEIVER_MATCH_STATUS.MISMATCH, reason: "Strong identifiers mismatched despite name similarity" };
      }
      // If only name is present, return INSUFFICIENT_DATA so it routes to manual review
      if (expName === verName || expName.includes(verName) || verName.includes(expName)) {
        return {
          status: RECEIVER_MATCH_STATUS.INSUFFICIENT_DATA,
          reason: "Account name match is secondary signal only; strong identifiers missing for auto-confirmation"
        };
      }
      return { status: RECEIVER_MATCH_STATUS.MISMATCH, reason: "Account name mismatch" };
    }

    return {
      status: RECEIVER_MATCH_STATUS.INSUFFICIENT_DATA,
      reason: "No matching identifiers or names found to verify receiver identity"
    };
  }
}

module.exports = {
  RECEIVER_MATCH_STATUS,
  ReceiverMatcher
};
