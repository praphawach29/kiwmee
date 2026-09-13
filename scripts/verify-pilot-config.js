const { hasFeature, getBusinessEntitlements } = require("../src/licensing");
const { getBusinessPaymentPolicy } = require("../src/config");
const { FEATURES } = require("../src/licensing/features");

async function verify() {
  const pilotId = "default";
  const nonPilotId = "non_pilot_tenant_999";

  const pilotPayment = await hasFeature(pilotId, FEATURES.payment);
  const pilotDeposit = await hasFeature(pilotId, FEATURES.deposit);
  const pilotSlip = await hasFeature(pilotId, FEATURES.slipVerification);
  const pilotAutoConfirm = await hasFeature(pilotId, FEATURES.autoPaymentConfirmation);
  const pilotRefund = await hasFeature(pilotId, FEATURES.refundManagement);
  const pilotPolicy = getBusinessPaymentPolicy();

  console.log("=== PILOT (default) Entitlements ===");
  console.log("PILOT_PAYMENT_ENABLED:", pilotPayment ? "YES" : "NO");
  console.log("PILOT_DEPOSIT_ENABLED:", pilotDeposit ? "YES" : "NO");
  console.log("PILOT_SLIP_VERIFICATION:", pilotSlip ? "YES" : "NO");
  console.log("AUTO_CONFIRM:", pilotAutoConfirm ? "TRUE" : "FALSE");
  console.log("REFUND_MANAGEMENT:", pilotRefund ? "TRUE" : "FALSE");
  console.log("Deposit Policy:", JSON.stringify(pilotPolicy));

  const nonPilotPayment = await hasFeature(nonPilotId, FEATURES.payment);
  const nonPilotDeposit = await hasFeature(nonPilotId, FEATURES.deposit);
  const nonPilotSlip = await hasFeature(nonPilotId, FEATURES.slipVerification);
  const nonPilotAutoConfirm = await hasFeature(nonPilotId, FEATURES.autoPaymentConfirmation);

  console.log("\n=== NON-PILOT Entitlements ===");
  console.log("NON_PILOT_PAYMENT:", nonPilotPayment ? "TRUE" : "FALSE");
  console.log("NON_PILOT_DEPOSIT:", nonPilotDeposit ? "TRUE" : "FALSE");
  console.log("NON_PILOT_SLIP_VERIFICATION:", nonPilotSlip ? "TRUE" : "FALSE");
  console.log("NON_PILOT_AUTO_CONFIRM:", nonPilotAutoConfirm ? "TRUE" : "FALSE");

  if (pilotAutoConfirm) {
    console.error("\n[CRITICAL ERROR] EMERGENCY STOP: autoPaymentConfirmation is TRUE!");
    process.exit(1);
  }
}

verify().catch(err => {
  console.error(err);
  process.exit(1);
});
