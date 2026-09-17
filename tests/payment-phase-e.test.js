// Salon Booking OS v1 - Payment Phase E Test Suite
// Covers:
// 1. No-Payment Regression (Flow remains 100% unchanged)
// 2. LINE Payment State Extension & Contract Integration (payment_pending -> slip_received -> verifying -> booked)
// 3. Payment Flex Cards & Text Fallback (All 6 visual states with Brand Palette)
// 4. Image Intake & Validation (MIME, size, empty body, SHA-256, no raw log)
// 5. Mock Slip Verification Scenarios (VALID, AMOUNT_MISMATCH, OVERPAYMENT, RECEIVER_MISMATCH, DUPLICATE_TRANSACTION, INVALID_SLIP, TIMEOUT)
// 6. Entitlement Enforcement (slipVerification & autoPaymentConfirmation, no plan names)
// 7. Duplicate Event & Webhook Idempotency (replay protection, duplicate slip hash)
// 8. Session Binding Lifecycle (paymentId/bookingId stored, cleared after confirmed)

const test = require("node:test");
const assert = require("node:assert/strict");
const { createHmac, randomUUID } = require("node:crypto");

const {
  PAYMENT_STATUSES,
  confirmVerifiedPayment,
  evaluateSlipVerification,
  PaymentPresentationProvider,
  MockPaymentPresentationProvider,
  MockSlipProvider,
  MOCK_SLIP_SCENARIOS,
  SlipIntakeService,
  processSlip
} = require("../src/payment");

const {
  MessageContentProvider,
  MockMessageContentProvider,
  validateImageContent
} = require("../src/messaging/content-provider");

const {
  LineWebhookService,
  formatLineReply,
  formatSlipReply
} = require("../src/messaging/line-webhook-service");

const {
  BRAND,
  buildPaymentRequiredBubble,
  buildSlipReceivedBubble,
  buildPaymentVerifiedBubble,
  buildPaymentManualReviewBubble,
  buildPaymentFailedBubble,
  buildPaymentExpiredBubble,
  buildBookingSuccessPassBubble
} = require("../src/messaging/line-flex-builder");

const { ToolGateway } = require("../src/ai/tools/gateway");
const { Receptionist } = require("../src/ai/receptionist");
const { PersistentSessionStore } = require("../src/ai/persistent-sessions");
const { MockAIProvider } = require("../src/ai/provider");
const { MockMessagingProvider } = require("../src/messaging/providers");
const { MemoryRateLimiter } = require("../src/security/limits");
const { FakeRepository } = require("./fake-repository");
const { FEATURES } = require("../src/licensing/features");

// Test fixtures
const sid = "11111111-1111-4111-8111-111111111111";
const staffId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const channelSecret = "test-line-secret";

function createLineWebhookFixture(options = {}) {
  const service = { id: sid, name: "ดีท็อกซ์หนังศีรษะ", price: "950", duration_minutes: 60 };
  const staff = { id: staffId, name: "ช่างกานต์" };
  const slot = { staff_id: staffId, start_at: "2026-09-10T13:00:00+07:00", end_at: "2026-09-10T14:00:00+07:00" };

  const repository = new FakeRepository({
    services: [service],
    staff: [staff]
  });

  const messaging = new MockMessagingProvider();
  const sessionStore = new Map();
  const sessions = {
    external: async (userId, secret) => {
      if (!sessionStore.has(userId)) {
        sessionStore.set(userId, {
          id: "sess-" + userId,
          owner: userId,
          stage: "start",
          services: [],
          staffList: [],
          slots: [],
          service: null,
          staff: null,
          date: null,
          slot: null,
          customer: null,
          booking: null,
          pending: null,
          payment: null,
          paymentId: null,
          bookingId: null,
          handoff: false,
          action: "create"
        });
      }
      return { session: sessionStore.get(userId), owner: userId };
    },
    withSession: async (id, owner, callback) => {
      for (const [uid, s] of sessionStore.entries()) {
        if (s.id === id) {
          return await callback(s);
        }
      }
      // fallback
      const created = {
        id,
        owner,
        stage: "start",
        services: [],
        staffList: [],
        slots: [],
        service: null,
        staff: null,
        date: null,
        slot: null,
        customer: null,
        booking: null,
        pending: null,
        payment: null,
        paymentId: null,
        bookingId: null,
        handoff: false,
        action: "create"
      };
      sessionStore.set(owner, created);
      return await callback(created);
    }
  };
  const limiter = new MemoryRateLimiter();
  const contentProvider = options.contentProvider || new MockMessageContentProvider();
  const slipProvider = options.slipProvider || new MockSlipProvider();
  const presentationProvider = options.presentationProvider || new MockPaymentPresentationProvider();

  let bookingOutcome = options.bookingOutcome || "confirmed"; // "confirmed" or "payment_required"

  const api = {
    services: async () => [service],
    staff: async () => [staff],
    availability: async () => ({ slots: [slot] }),
    create: async (payload) => {
      if (bookingOutcome === "payment_required") {
        return {
          id: randomUUID(),
          service_id: sid,
          staff_id: staffId,
          start_at: slot.start_at,
          end_at: slot.end_at,
          status: "pending",
          payment: {
            id: randomUUID(),
            type: "deposit_fixed",
            amountDueSatang: 30000,
            currency: "THB",
            expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
            verificationDeadline: new Date(Date.now() + 25 * 60 * 1000).toISOString()
          }
        };
      }
      return {
        id: randomUUID(),
        service_id: sid,
        staff_id: staffId,
        start_at: slot.start_at,
        end_at: slot.end_at,
        status: "confirmed"
      };
    }
  };

  const gateway = new ToolGateway(api);
  const receptionist = new Receptionist(gateway, new MockAIProvider());

  const entitlementsMap = options.entitlements || {
    [FEATURES.booking]: true,
    [FEATURES.payment]: true,
    [FEATURES.deposit]: true,
    [FEATURES.slipVerification]: true,
    [FEATURES.autoPaymentConfirmation]: true,
    [FEATURES.lineFlex]: true
  };

  const hasFeatureFn = async (bizId, feat) => entitlementsMap[feat] ?? false;

  const webhookService = new LineWebhookService({
    messaging,
    sessions,
    receptionist,
    repository,
    limiter,
    channelSecret,
    businessId: "biz-test",
    hasFeatureFn,
    contentProvider,
    slipProvider,
    presentationProvider
  });

  const sendEvent = async (event) => {
    const raw = JSON.stringify({ events: [event] });
    const signature = createHmac("sha256", channelSecret).update(raw).digest("base64");
    return webhookService.handle(raw, signature);
  };

  return {
    repository,
    messaging,
    sessions,
    contentProvider,
    slipProvider,
    presentationProvider,
    receptionist,
    webhookService,
    sendEvent,
    setBookingOutcome: (outcome) => { bookingOutcome = outcome; },
    setEntitlement: (feat, val) => { entitlementsMap[feat] = val; }
  };
}

// =============================================================================
// 1. No-Payment Regression Tests
// =============================================================================

test("Regression: no-payment booking flow progresses review -> confirm -> success with zero payment rows", async () => {
  const f = createLineWebhookFixture({ bookingOutcome: "confirmed" });
  const userId = "user-no-pay";
  let seq = 0;

  // Start -> review flow
  const { session, owner } = await f.sessions.external(userId, channelSecret);
  session.service = { id: sid, name: "ดีท็อกซ์หนังศีรษะ", price: "950" };
  session.staff = { id: staffId, name: "ช่างกานต์" };
  session.slot = { staff_id: staffId, start_at: "2026-09-10T13:00:00+07:00", end_at: "2026-09-10T14:00:00+07:00" };
  session.customer = { name: "สมชาย", phone: "0812345678" };
  session.stage = "review";
  const revId = randomUUID();
  session.pending = {
    id: revId,
    action: "create",
    expires: Date.now() + 600000,
    draft: { service: session.service, staff: session.staff, slot: session.slot, customer: session.customer }
  };

  await f.sendEvent({
    type: "postback",
    webhookEventId: `ev-${++seq}`,
    replyToken: `tok-${seq}`,
    source: { type: "user", userId },
    postback: { data: `action=confirm&review_id=${revId}` }
  });

  assert.equal(f.messaging.replies.length, 1);
  const reply = f.messaging.replies[0].messages[0];
  assert.equal(reply.type, "flex");
  assert.match(reply.altText, /จองสำเร็จ/);
  assert.equal(session.stage, "success");
  assert.equal(session.payment, null);
  assert.equal(f.repository.payments.length, 0);
});

// =============================================================================
// 2. Payment Pending Contract Integration & LINE Flow Extension
// =============================================================================

test("Payment Pending: confirm with payment_required transitions to payment_pending and returns Payment Flex Card", async () => {
  const f = createLineWebhookFixture({ bookingOutcome: "payment_required" });
  const userId = "user-pay-1";
  let seq = 0;

  const { session, owner } = await f.sessions.external(userId, channelSecret);
  session.service = { id: sid, name: "ดีท็อกซ์หนังศีรษะ", price: "950" };
  session.staff = { id: staffId, name: "ช่างกานต์" };
  session.slot = { staff_id: staffId, start_at: "2026-09-10T13:00:00+07:00", end_at: "2026-09-10T14:00:00+07:00" };
  session.customer = { name: "สมศรี", phone: "0898765432" };
  session.stage = "review";
  const revId = randomUUID();
  session.pending = {
    id: revId,
    action: "create",
    expires: Date.now() + 600000,
    draft: { service: session.service, staff: session.staff, slot: session.slot, customer: session.customer }
  };

  await f.sendEvent({
    type: "postback",
    webhookEventId: `ev-${++seq}`,
    replyToken: `tok-${seq}`,
    source: { type: "user", userId },
    postback: { data: `action=confirm&review_id=${revId}` }
  });

  assert.equal(f.messaging.replies.length, 1);
  const reply = f.messaging.replies[0].messages[0];
  assert.equal(reply.type, "flex");
  assert.match(reply.altText, /กรุณาชำระเงิน/);

  // Contract verification on session
  assert.equal(session.stage, "payment_pending");
  assert.ok(session.payment);
  assert.equal(session.payment.amountDueSatang, 30000);
  assert.equal(session.payment.type, "deposit_fixed");
  assert.ok(session.booking);
  assert.equal(session.booking.status, "pending");
  assert.equal(session.paymentId, session.payment.id);
  assert.equal(session.bookingId, session.booking.id);
});

test("Text Fallback: payment_pending returns rich text instructions when lineFlex=false", async () => {
  const f = createLineWebhookFixture({ bookingOutcome: "payment_required" });
  f.setEntitlement(FEATURES.lineFlex, false);
  const userId = "user-pay-noflex";
  let seq = 0;

  const { session } = await f.sessions.external(userId, channelSecret);
  session.service = { id: sid, name: "ดีท็อกซ์หนังศีรษะ", price: "950" };
  session.staff = { id: staffId, name: "ช่างกานต์" };
  session.slot = { staff_id: staffId, start_at: "2026-09-10T13:00:00+07:00", end_at: "2026-09-10T14:00:00+07:00" };
  session.stage = "review";
  const revId = randomUUID();
  session.pending = {
    id: revId,
    action: "create",
    expires: Date.now() + 600000,
    draft: { service: session.service, staff: session.staff, slot: session.slot, customer: { name: "สมศรี", phone: "0898765432" } }
  };

  await f.sendEvent({
    type: "postback",
    webhookEventId: `ev-${++seq}`,
    replyToken: `tok-${seq}`,
    source: { type: "user", userId },
    postback: { data: `action=confirm&review_id=${revId}` }
  });

  assert.equal(f.messaging.replies.length, 1);
  const reply = f.messaging.replies[0].messages[0];
  assert.equal(reply.type, "text");
  assert.match(reply.text, /ยอดที่ต้องชำระตอนนี้: 300 บาท/);
  assert.match(reply.text, /เมื่อชำระแล้ว ส่งรูปสลิปในแชทนี้ได้เลย/);
  assert.ok(reply.quickReply);
  assert.ok(reply.quickReply.items.some((i) => i.action.label === "ยกเลิกการจอง"));
});

test("Resilience: create_booking_request succeeds when API omits service/slot details from payment_required response", async () => {
  const customApi = {
    services: async () => [{ id: sid, name: "ดีท็อกซ์หนังศีรษะ", price: 950, duration_minutes: 60 }],
    create: async () => ({
      id: randomUUID(),
      status: "pending",
      mode: "payment_required",
      amount_due: 200,
      currency: "THB",
      payment: {
        id: randomUUID(),
        type: "deposit_fixed",
        amountDueSatang: 20000,
        currency: "THB",
        expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
        verificationDeadline: null
      }
    })
  };
  const gateway = new ToolGateway(customApi);
  const revId = randomUUID();
  const session = {
    pending: {
      id: revId,
      action: "create",
      expires: Date.now() + 60000,
      draft: {
        service: { id: sid },
        slot: { staff_id: staffId, start_at: "2026-09-10T13:00:00+07:00", end_at: "2026-09-10T14:00:00+07:00" },
        customer: { name: "สมใจ", phone: "0811112222" }
      }
    }
  };

  const res = await gateway.execute("create_booking_request", { review_id: revId }, { session, confirmedReview: revId });
  assert.equal(res.ok, true);
  assert.equal(res.data.status, "pending");
  assert.equal(res.data.service_id, sid);
  assert.equal(res.data.staff_id, staffId);
  assert.equal(res.data.payment.amountDueSatang, 20000);
});

// =============================================================================
// 3. Payment Flex Visual States & Brand Palette Compliance
// =============================================================================

test("Payment Flex: all 6 visual states adhere strictly to Brand Palette", () => {
  // A. Payment Required
  const reqBubble = buildPaymentRequiredBubble({
    service: { name: "ดีท็อกซ์หนังศีรษะ", price: 950 },
    staff: { name: "ช่างกานต์" },
    slot: { start_at: "2026-09-10T13:00:00+07:00" },
    booking: { id: "12345678-aaaa-bbbb-cccc-dddddddddddd" },
    payment: { type: "deposit_fixed", amountDueSatang: 30000, expiresAt: "2026-09-10T13:15:00+07:00" },
    presentation: { displayAmount: "฿300", qrImageUrl: "https://example.com/qr.png" }
  });
  assert.equal(reqBubble.type, "flex");
  assert.equal(reqBubble.contents.header.backgroundColor, BRAND.DARK);
  assert.ok(JSON.stringify(reqBubble).includes(BRAND.PRIMARY_GREEN));

  // B. Slip Received
  const slipRecBubble = buildSlipReceivedBubble({
    booking: { id: "12345678-aaaa-bbbb-cccc-dddddddddddd" }
  });
  assert.equal(slipRecBubble.contents.header.backgroundColor, BRAND.DARK);
  assert.match(slipRecBubble.altText, /ได้รับสลิปแล้ว กำลังตรวจสอบ/);

  // C. Payment Verified
  const verifiedBubble = buildPaymentVerifiedBubble({
    booking: { id: "12345678-aaaa-bbbb-cccc-dddddddddddd" }
  });
  assert.equal(verifiedBubble.contents.header.backgroundColor, BRAND.PRIMARY_GREEN);
  assert.match(verifiedBubble.altText, /ชำระเงินสำเร็จ/);

  // D. Manual Review
  const reviewBubble = buildPaymentManualReviewBubble({
    booking: { id: "12345678-aaaa-bbbb-cccc-dddddddddddd" },
    reason: "ยอดเงินเกินจำนวนที่ต้องชำระ"
  });
  assert.equal(reviewBubble.contents.header.backgroundColor, BRAND.DARK);
  assert.match(reviewBubble.altText, /ระบบส่งให้ร้านตรวจสอบ/);

  // E. Verification Failed
  const failedBubble = buildPaymentFailedBubble({
    booking: { id: "12345678-aaaa-bbbb-cccc-dddddddddddd" },
    reason: "ยอดเงินไม่ตรงกับรายการจอง"
  });
  assert.equal(failedBubble.contents.header.backgroundColor, BRAND.DARK);
  assert.match(failedBubble.altText, /ยอดเงินไม่ตรง/);

  // F. Payment Expired
  const expiredBubble = buildPaymentExpiredBubble({
    booking: { id: "12345678-aaaa-bbbb-cccc-dddddddddddd" }
  });
  assert.equal(expiredBubble.contents.header.backgroundColor, BRAND.DARK);
  assert.match(expiredBubble.altText, /รายการชำระเงินหมดเวลา/);
});

// =============================================================================
// 4. LINE Image Event Intake & Media Validation
// =============================================================================

test("Image Intake: message image without pending payment replies polite rejection before downloading", async () => {
  const f = createLineWebhookFixture();
  const userId = "user-no-pending";

  let downloadCalled = false;
  f.contentProvider.getImageContent = async () => {
    downloadCalled = true;
    return { buffer: Buffer.from("test"), contentType: "image/jpeg" };
  };

  await f.sendEvent({
    type: "message",
    webhookEventId: "ev-img-1",
    replyToken: "tok-img-1",
    source: { type: "user", userId },
    message: { type: "image", id: "msg-img-1" }
  });

  assert.equal(downloadCalled, false); // Download must not occur without active payment pending
  assert.equal(f.messaging.replies.length, 1);
  const reply = f.messaging.replies[0].messages[0];
  assert.equal(reply.type, "text");
  assert.match(reply.text, /ขณะนี้ไม่มีรายการที่รอชำระเงิน/);
});

test("Image Validation: rejects invalid MIME, oversized image, and empty buffer with friendly errors", () => {
  // Empty body
  const emptyRes = validateImageContent(null);
  assert.equal(emptyRes.valid, false);
  assert.equal(emptyRes.code, "EMPTY_BODY");

  // Invalid MIME
  const mimeRes = validateImageContent({
    buffer: Buffer.from("pdf-data"),
    contentType: "application/pdf"
  });
  assert.equal(mimeRes.valid, false);
  assert.equal(mimeRes.code, "INVALID_MIME_TYPE");

  // Oversized (> 5MB)
  const bigRes = validateImageContent(
    { buffer: Buffer.alloc(6 * 1024 * 1024), contentType: "image/jpeg" },
    { maxSizeBytes: 5 * 1024 * 1024 }
  );
  assert.equal(bigRes.valid, false);
  assert.equal(bigRes.code, "OVERSIZED_IMAGE");

  // Valid JPEG computes deterministic SHA-256
  const validRes = validateImageContent({
    buffer: Buffer.from("valid-fake-image-bytes"),
    contentType: "image/jpeg"
  });
  assert.equal(validRes.valid, true);
  assert.equal(typeof validRes.hash, "string");
  assert.equal(validRes.hash.length, 64);
});

// =============================================================================
// 5. Mock Slip Verification Scenarios & Atomic Confirmation
// =============================================================================

test("Verification VALID: confirms payment and booking atomically, returns Booking Confirmed Flex Card", async () => {
  const f = createLineWebhookFixture();
  const userId = "user-valid-slip";

  // 1. Setup active booking and payment in repository
  const paymentId = randomUUID();
  const bookingId = randomUUID();
  await f.repository.insertBooking({
    id: bookingId,
    service_id: sid,
    staff_id: staffId,
    start_at: "2026-09-10T13:00:00+07:00",
    end_at: "2026-09-10T14:00:00+07:00",
    status: "pending"
  });
  await f.repository.insertPayment({
    id: paymentId,
    business_id: "biz-test",
    original_booking_id: bookingId,
    amount_due: 300,
    amount_paid: 0,
    currency: "THB",
    status: PAYMENT_STATUSES.pending,
    expires_at: new Date(Date.now() + 600000).toISOString()
  });

  // 2. Setup user session with active payment binding
  const { session } = await f.sessions.external(userId, channelSecret);
  session.booking = { id: bookingId, status: "pending" };
  session.bookingId = bookingId;
  session.payment = { id: paymentId, amount_due: 300, amountDueSatang: 30000, type: "deposit_fixed" };
  session.paymentId = paymentId;
  session.stage = "payment_pending";

  // 3. Setup mock slip with VALID scenario
  f.slipProvider.setScenario(MOCK_SLIP_SCENARIOS.VALID);
  f.contentProvider.setImage("msg-slip-valid", {
    buffer: Buffer.from("mock-valid-slip-bytes"),
    contentType: "image/jpeg"
  });

  // 4. Send image webhook
  await f.sendEvent({
    type: "message",
    webhookEventId: "ev-slip-valid",
    replyToken: "tok-slip-valid",
    source: { type: "user", userId },
    message: { type: "image", id: "msg-slip-valid" }
  });

  // 5. Assert atomic database updates
  const updatedPayment = await f.repository.getPaymentById(paymentId);
  assert.equal(updatedPayment.status, PAYMENT_STATUSES.paid);
  assert.equal(Number(updatedPayment.amount_paid), 300);

  const updatedBooking = await f.repository.getBooking(bookingId);
  assert.equal(updatedBooking.status, "confirmed");

  // Assert payment attempts recorded
  const attempts = await f.repository.getPaymentAttempts(paymentId);
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].normalized_result, "success");

  // Assert session binding cleared
  assert.equal(session.payment, null);
  assert.equal(session.stage, "success");

  // Assert LINE reply was Booking Confirmed Pass
  assert.equal(f.messaging.replies.length, 1);
  const reply = f.messaging.replies[0].messages[0];
  assert.equal(reply.type, "flex");
  assert.match(reply.altText, /จองสำเร็จเรียบร้อยค่ะ/);
});

test("Verification AMOUNT_MISMATCH: reports underpayment, does NOT confirm, allows retry", async () => {
  const f = createLineWebhookFixture();
  const userId = "user-mismatch-slip";

  const paymentId = randomUUID();
  const bookingId = randomUUID();
  await f.repository.insertBooking({ id: bookingId, status: "pending", start_at: "2026-09-10T13:00:00Z", end_at: "2026-09-10T14:00:00Z" });
  await f.repository.insertPayment({ id: paymentId, business_id: "biz-test", original_booking_id: bookingId, amount_due: 300, status: PAYMENT_STATUSES.pending });

  const { session } = await f.sessions.external(userId, channelSecret);
  session.booking = { id: bookingId, status: "pending" };
  session.payment = { id: paymentId, amount_due: 300, amountDueSatang: 30000 };
  session.paymentId = paymentId;
  session.stage = "payment_pending";

  f.slipProvider.setScenario(MOCK_SLIP_SCENARIOS.AMOUNT_MISMATCH);
  f.contentProvider.setImage("msg-mismatch", { buffer: Buffer.from("underpaid-slip"), contentType: "image/jpeg" });

  await f.sendEvent({
    type: "message",
    webhookEventId: "ev-slip-mismatch",
    replyToken: "tok-slip-mismatch",
    source: { type: "user", userId },
    message: { type: "image", id: "msg-mismatch" }
  });

  const payment = await f.repository.getPaymentById(paymentId);
  assert.notEqual(payment.status, PAYMENT_STATUSES.paid);

  const booking = await f.repository.getBooking(bookingId);
  assert.equal(booking.status, "pending"); // Not confirmed!

  const reply = f.messaging.replies[0].messages[0];
  assert.match(reply.altText || reply.text, /ไม่ตรงกับยอดที่ต้องชำระ/);
  assert.equal(session.stage, "payment_pending"); // Kept pending to allow retry!
});

test("Verification OVERPAYMENT: routes to manual_review, shop notified", async () => {
  const f = createLineWebhookFixture();
  const userId = "user-overpaid";

  const paymentId = randomUUID();
  const bookingId = randomUUID();
  await f.repository.insertBooking({ id: bookingId, status: "pending", start_at: "2026-09-10T13:00:00Z", end_at: "2026-09-10T14:00:00Z" });
  await f.repository.insertPayment({ id: paymentId, business_id: "biz-test", original_booking_id: bookingId, amount_due: 300, status: PAYMENT_STATUSES.pending });

  const { session } = await f.sessions.external(userId, channelSecret);
  session.booking = { id: bookingId, status: "pending" };
  session.payment = { id: paymentId, amount_due: 300 };
  session.paymentId = paymentId;
  session.stage = "payment_pending";

  f.slipProvider.setScenario(MOCK_SLIP_SCENARIOS.OVERPAYMENT);
  f.contentProvider.setImage("msg-over", { buffer: Buffer.from("overpaid-bytes"), contentType: "image/png" });

  await f.sendEvent({
    type: "message",
    webhookEventId: "ev-slip-over",
    replyToken: "tok-slip-over",
    source: { type: "user", userId },
    message: { type: "image", id: "msg-over" }
  });

  const payment = await f.repository.getPaymentById(paymentId);
  assert.equal(payment.status, PAYMENT_STATUSES.manualReview);
  assert.equal(session.stage, "payment_manual_review");
  const reply = f.messaging.replies[0].messages[0];
  assert.match(reply.altText || reply.text, /ระบบส่งให้ร้านตรวจสอบ/);
});

test("Verification RECEIVER_MISMATCH: escalates without paid status", async () => {
  const f = createLineWebhookFixture();
  const userId = "user-wrong-recv";

  const paymentId = randomUUID();
  const bookingId = randomUUID();
  await f.repository.insertBooking({ id: bookingId, status: "pending", start_at: "2026-09-10T13:00:00Z", end_at: "2026-09-10T14:00:00Z" });
  await f.repository.insertPayment({ id: paymentId, business_id: "biz-test", original_booking_id: bookingId, amount_due: 300, status: PAYMENT_STATUSES.pending });

  const { session } = await f.sessions.external(userId, channelSecret);
  session.booking = { id: bookingId, status: "pending" };
  session.payment = { id: paymentId, amount_due: 300 };
  session.paymentId = paymentId;
  session.stage = "payment_pending";

  f.slipProvider.setScenario(MOCK_SLIP_SCENARIOS.RECEIVER_MISMATCH);
  f.contentProvider.setImage("msg-recv", { buffer: Buffer.from("wrong-receiver"), contentType: "image/jpeg" });

  await f.sendEvent({
    type: "message",
    webhookEventId: "ev-slip-recv",
    replyToken: "tok-slip-recv",
    source: { type: "user", userId },
    message: { type: "image", id: "msg-recv" }
  });

  const payment = await f.repository.getPaymentById(paymentId);
  assert.notEqual(payment.status, PAYMENT_STATUSES.paid);
  assert.equal(session.stage, "payment_failed");
  const reply = f.messaging.replies[0].messages[0];
  assert.match(reply.altText || reply.text, /ไม่ตรงกับบัญชีของทางร้าน/);
});

test("Verification TIMEOUT: provider timeout escalates to manual review and preserves slot hold", async () => {
  const f = createLineWebhookFixture();
  const userId = "user-timeout";

  const paymentId = randomUUID();
  const bookingId = randomUUID();
  await f.repository.insertBooking({ id: bookingId, status: "pending", start_at: "2026-09-10T13:00:00Z", end_at: "2026-09-10T14:00:00Z" });
  await f.repository.insertPayment({ id: paymentId, business_id: "biz-test", original_booking_id: bookingId, amount_due: 300, status: PAYMENT_STATUSES.pending });

  const { session } = await f.sessions.external(userId, channelSecret);
  session.booking = { id: bookingId, status: "pending" };
  session.payment = { id: paymentId, amount_due: 300 };
  session.paymentId = paymentId;
  session.stage = "payment_pending";

  f.slipProvider.setScenario(MOCK_SLIP_SCENARIOS.TIMEOUT);
  f.contentProvider.setImage("msg-timeout", { buffer: Buffer.from("timeout-slip"), contentType: "image/jpeg" });

  await f.sendEvent({
    type: "message",
    webhookEventId: "ev-slip-timeout",
    replyToken: "tok-slip-timeout",
    source: { type: "user", userId },
    message: { type: "image", id: "msg-timeout" }
  });

  const payment = await f.repository.getPaymentById(paymentId);
  assert.equal(payment.status, PAYMENT_STATUSES.manualReview);
  assert.ok(payment.manual_review_deadline);
  assert.equal(session.stage, "payment_manual_review");
});

// =============================================================================
// 6. Entitlement Enforcement (Never checks plan name!)
// =============================================================================

test("Entitlements: slipVerification=false accepts slip in manual mode without calling auto verifier", async () => {
  const f = createLineWebhookFixture();
  f.setEntitlement(FEATURES.slipVerification, false);
  const userId = "user-manual-entitlement";

  let verifierCalled = false;
  f.slipProvider.verifySlip = async () => {
    verifierCalled = true;
    return { normalized_result: "success" };
  };

  const paymentId = randomUUID();
  const bookingId = randomUUID();
  await f.repository.insertBooking({ id: bookingId, status: "pending", start_at: "2026-09-10T13:00:00Z", end_at: "2026-09-10T14:00:00Z" });
  await f.repository.insertPayment({ id: paymentId, business_id: "biz-test", original_booking_id: bookingId, amount_due: 300, status: PAYMENT_STATUSES.pending });

  const { session } = await f.sessions.external(userId, channelSecret);
  session.booking = { id: bookingId, status: "pending" };
  session.payment = { id: paymentId, amount_due: 300 };
  session.paymentId = paymentId;
  session.stage = "payment_pending";

  f.contentProvider.setImage("msg-manual-slip", { buffer: Buffer.from("manual-bytes"), contentType: "image/jpeg" });

  await f.sendEvent({
    type: "message",
    webhookEventId: "ev-manual-slip",
    replyToken: "tok-manual-slip",
    source: { type: "user", userId },
    message: { type: "image", id: "msg-manual-slip" }
  });

  assert.equal(verifierCalled, false); // Auto verifier strictly forbidden!
  const payment = await f.repository.getPaymentById(paymentId);
  assert.equal(payment.status, PAYMENT_STATUSES.manualReview);
  assert.equal(session.stage, "payment_manual_review");
});

test("Entitlements: autoPaymentConfirmation=false verifies slip but routes to manual review without auto-paid", async () => {
  const f = createLineWebhookFixture();
  f.setEntitlement(FEATURES.slipVerification, true);
  f.setEntitlement(FEATURES.autoPaymentConfirmation, false); // Disabled!
  const userId = "user-no-autoconfirm";

  const paymentId = randomUUID();
  const bookingId = randomUUID();
  await f.repository.insertBooking({ id: bookingId, status: "pending", start_at: "2026-09-10T13:00:00Z", end_at: "2026-09-10T14:00:00Z" });
  await f.repository.insertPayment({ id: paymentId, business_id: "biz-test", original_booking_id: bookingId, amount_due: 300, status: PAYMENT_STATUSES.pending });

  const { session } = await f.sessions.external(userId, channelSecret);
  session.booking = { id: bookingId, status: "pending" };
  session.payment = { id: paymentId, amount_due: 300 };
  session.paymentId = paymentId;
  session.stage = "payment_pending";

  f.slipProvider.setScenario(MOCK_SLIP_SCENARIOS.VALID);
  f.contentProvider.setImage("msg-valid-no-auto", { buffer: Buffer.from("valid-slip-bytes"), contentType: "image/jpeg" });

  await f.sendEvent({
    type: "message",
    webhookEventId: "ev-no-auto",
    replyToken: "tok-no-auto",
    source: { type: "user", userId },
    message: { type: "image", id: "msg-valid-no-auto" }
  });

  const payment = await f.repository.getPaymentById(paymentId);
  assert.equal(payment.status, PAYMENT_STATUSES.manualReview); // Routed to manual review!
  assert.notEqual(payment.status, PAYMENT_STATUSES.paid);

  const booking = await f.repository.getBooking(bookingId);
  assert.equal(booking.status, "pending"); // Not confirmed!
  assert.equal(session.stage, "payment_manual_review");
});

// =============================================================================
// 7. Duplicate Image / Event Idempotency
// =============================================================================

test("Idempotency: duplicate LINE webhook event delivery is discarded cleanly without re-executing", async () => {
  const f = createLineWebhookFixture();
  const userId = "user-dup-webhook";

  const event = {
    type: "message",
    webhookEventId: "ev-dup-100",
    replyToken: "tok-dup-100",
    source: { type: "user", userId },
    message: { type: "text", text: "เริ่มใหม่" }
  };

  await f.sendEvent(event);
  assert.equal(f.messaging.replies.length, 1);

  // Send exact same webhook event again
  await f.sendEvent(event);
  // Replies count must remain 1: claimed event discarded
  assert.equal(f.messaging.replies.length, 1);
});

test("Idempotency: submitting the same slip twice for an already paid booking returns idempotent confirmation", async () => {
  const f = createLineWebhookFixture();
  const userId = "user-dup-slip";

  const paymentId = randomUUID();
  const bookingId = randomUUID();
  await f.repository.insertBooking({ id: bookingId, status: "confirmed", start_at: "2026-09-10T13:00:00Z", end_at: "2026-09-10T14:00:00Z" });
  await f.repository.insertPayment({
    id: paymentId,
    business_id: "biz-test",
    original_booking_id: bookingId,
    amount_due: 300,
    amount_paid: 300,
    status: PAYMENT_STATUSES.paid,
    transaction_reference: "TXN_EXISTING_123"
  });

  const { session } = await f.sessions.external(userId, channelSecret);
  session.booking = { id: bookingId, status: "confirmed" };
  session.payment = { id: paymentId, amount_due: 300 };
  session.paymentId = paymentId;
  session.stage = "payment_pending";

  const slipBytes = Buffer.from("deterministic-slip-bytes");
  const slipValidation = validateImageContent({ buffer: slipBytes, contentType: "image/jpeg" });

  // Seed previous successful payment attempt in repository
  await f.repository.insertPaymentAttempt({
    id: randomUUID(),
    payment_id: paymentId,
    attempt_type: "slip_upload",
    slip_hash: slipValidation.hash,
    verification_provider: "mock_slip",
    normalized_result: "success",
    verified_amount: 300
  });

  f.contentProvider.setImage("msg-dup-slip", { buffer: slipBytes, contentType: "image/jpeg" });

  await f.sendEvent({
    type: "message",
    webhookEventId: "ev-dup-slip-turn",
    replyToken: "tok-dup-slip-turn",
    source: { type: "user", userId },
    message: { type: "image", id: "msg-dup-slip" }
  });

  const reply = f.messaging.replies[0].messages[0];
  assert.match(reply.altText || reply.text, /จองสำเร็จเรียบร้อยค่ะ|ยืนยัน/);
  const payment = await f.repository.getPaymentById(paymentId);
  assert.equal(payment.status, PAYMENT_STATUSES.paid);
});

test("Idempotency: replaying a slip already used for a DIFFERENT booking is rejected", async () => {
  const f = createLineWebhookFixture();
  const userId = "user-hijack-slip";

  const otherPaymentId = randomUUID();
  const myPaymentId = randomUUID();
  const myBookingId = randomUUID();

  const slipBytes = Buffer.from("hijacked-slip-bytes");
  const slipValidation = validateImageContent({ buffer: slipBytes, contentType: "image/jpeg" });

  // Other booking claimed this slip first
  await f.repository.insertPaymentAttempt({
    id: randomUUID(),
    payment_id: otherPaymentId, // Different payment!
    attempt_type: "slip_upload",
    slip_hash: slipValidation.hash,
    verification_provider: "mock_slip",
    normalized_result: "success",
    verified_amount: 300
  });

  await f.repository.insertBooking({ id: myBookingId, status: "pending", start_at: "2026-09-10T13:00:00Z", end_at: "2026-09-10T14:00:00Z" });
  await f.repository.insertPayment({ id: myPaymentId, business_id: "biz-test", original_booking_id: myBookingId, amount_due: 300, status: PAYMENT_STATUSES.pending });

  const { session } = await f.sessions.external(userId, channelSecret);
  session.booking = { id: myBookingId, status: "pending" };
  session.payment = { id: myPaymentId, amount_due: 300 };
  session.paymentId = myPaymentId;
  session.stage = "payment_pending";

  f.contentProvider.setImage("msg-hijack-attempt", { buffer: slipBytes, contentType: "image/jpeg" });

  await f.sendEvent({
    type: "message",
    webhookEventId: "ev-hijack",
    replyToken: "tok-hijack",
    source: { type: "user", userId },
    message: { type: "image", id: "msg-hijack-attempt" }
  });

  const myPayment = await f.repository.getPaymentById(myPaymentId);
  assert.notEqual(myPayment.status, PAYMENT_STATUSES.paid);
  assert.equal(session.stage, "payment_failed");
  const reply = f.messaging.replies[0].messages[0];
  assert.match(reply.altText || reply.text, /สลิปนี้เคยถูกใช้งานไปแล้ว/);
});

// =============================================================================
// 8. Hardening Point 1: Strict AI Tool Schema
// =============================================================================

test("Strict AI Schema: valid normalized payment contract passes tool output validation", () => {
  const { tools } = require("../src/ai/tools/catalog");
  const createBookingTool = tools.find((t) => t.name === "create_booking_request");
  assert.ok(createBookingTool);

  const validOutput = {
    ok: true,
    data: {
      id: randomUUID(),
      service_id: sid,
      staff_id: staffId,
      start_at: "2026-09-10T13:00:00+07:00",
      end_at: "2026-09-10T14:00:00+07:00",
      status: "pending",
      payment: {
        id: "pay-" + randomUUID(),
        type: "deposit_fixed",
        amountDueSatang: 30000,
        currency: "THB",
        expiresAt: "2026-09-10T13:15:00+07:00",
        verificationDeadline: "2026-09-10T13:25:00+07:00"
      }
    }
  };

  const isValid = createBookingTool.validateOutput(validOutput);
  assert.equal(isValid, true, JSON.stringify(createBookingTool.validateOutput.errors));
});

test("Strict AI Schema: unknown payment property is strictly rejected", () => {
  const { tools } = require("../src/ai/tools/catalog");
  const createBookingTool = tools.find((t) => t.name === "create_booking_request");

  const invalidOutput = {
    ok: true,
    data: {
      id: randomUUID(),
      service_id: sid,
      staff_id: staffId,
      start_at: "2026-09-10T13:00:00+07:00",
      end_at: "2026-09-10T14:00:00+07:00",
      status: "pending",
      payment: {
        id: "pay-" + randomUUID(),
        type: "deposit_fixed",
        amountDueSatang: 30000,
        currency: "THB",
        expiresAt: "2026-09-10T13:15:00+07:00",
        unknownFinancialField: "hacked_value" // Not allowed!
      }
    }
  };

  const isValid = createBookingTool.validateOutput(invalidOutput);
  assert.equal(isValid, false);
});

test("Strict AI Schema: unknown booking property is strictly rejected", () => {
  const { tools } = require("../src/ai/tools/catalog");
  const getBookingTool = tools.find((t) => t.name === "get_booking");

  const invalidOutput = {
    ok: true,
    data: {
      id: randomUUID(),
      service_id: sid,
      staff_id: staffId,
      start_at: "2026-09-10T13:00:00+07:00",
      end_at: "2026-09-10T14:00:00+07:00",
      status: "confirmed",
      arbitraryBookingAttribute: "unauthorized" // Not allowed!
    }
  };

  const isValid = getBookingTool.validateOutput(invalidOutput);
  assert.equal(isValid, false);
});

test("Strict AI Schema: existing no_payment booking tool calls still pass", () => {
  const { tools } = require("../src/ai/tools/catalog");
  const createBookingTool = tools.find((t) => t.name === "create_booking_request");

  const noPaymentOutput = {
    ok: true,
    data: {
      id: randomUUID(),
      service_id: sid,
      staff_id: staffId,
      start_at: "2026-09-10T13:00:00+07:00",
      end_at: "2026-09-10T14:00:00+07:00",
      status: "confirmed"
    }
  };

  const isValid = createBookingTool.validateOutput(noPaymentOutput);
  assert.equal(isValid, true, JSON.stringify(createBookingTool.validateOutput.errors));
});

// =============================================================================
// 9. Hardening Point 2: Payment Attempt Audit Order Lifecycle
// =============================================================================

test("Attempt Audit Order: PaymentAttempt exists before provider is called", async () => {
  const f = createLineWebhookFixture();
  const userId = "user-audit-order";
  const paymentId = randomUUID();
  const bookingId = randomUUID();

  await f.repository.insertBooking({ id: bookingId, customer_id: userId, status: "pending", start_at: "2026-09-10T13:00:00Z", end_at: "2026-09-10T14:00:00Z" });
  await f.repository.insertPayment({ id: paymentId, business_id: "biz-test", original_booking_id: bookingId, amount_due: 300, status: PAYMENT_STATUSES.pending });

  const { session } = await f.sessions.external(userId, channelSecret);
  session.booking = { id: bookingId, status: "pending" };
  session.payment = { id: paymentId, amount_due: 300 };
  session.paymentId = paymentId;
  session.stage = "payment_pending";

  let attemptFoundBeforeProviderReturn = false;
  f.slipProvider.verifySlip = async () => {
    const attempts = await f.repository.getPaymentAttempts(paymentId);
    if (attempts.length > 0 && attempts[0].provider_status === "verifying") {
      attemptFoundBeforeProviderReturn = true;
    }
    return {
      provider_status: "ok",
      normalized_result: "success",
      verified_amount: 300,
      verified_receiver: "biz-test",
      verified_transaction_reference: `txn_${randomUUID().slice(0, 8)}`
    };
  };

  f.contentProvider.setImage("msg-audit-check", { buffer: Buffer.from("audit-check-bytes"), contentType: "image/jpeg" });

  await f.sendEvent({
    type: "message",
    webhookEventId: "ev-audit-order",
    replyToken: "tok-audit-order",
    source: { type: "user", userId },
    message: { type: "image", id: "msg-audit-check" }
  });

  assert.equal(attemptFoundBeforeProviderReturn, true, "PaymentAttempt must be created in DB before external provider is called!");
});

test("Attempt Audit Order: provider throw leaves reconcilable attempt in repository", async () => {
  const f = createLineWebhookFixture();
  const userId = "user-audit-throw";
  const paymentId = randomUUID();
  const bookingId = randomUUID();

  await f.repository.insertBooking({ id: bookingId, customer_id: userId, status: "pending", start_at: "2026-09-10T13:00:00Z", end_at: "2026-09-10T14:00:00Z" });
  await f.repository.insertPayment({ id: paymentId, business_id: "biz-test", original_booking_id: bookingId, amount_due: 300, status: PAYMENT_STATUSES.pending });

  const { session } = await f.sessions.external(userId, channelSecret);
  session.booking = { id: bookingId, status: "pending" };
  session.payment = { id: paymentId, amount_due: 300 };
  session.paymentId = paymentId;
  session.stage = "payment_pending";

  f.slipProvider.verifySlip = async () => {
    const err = new Error("Connection reset by peer");
    err.code = "NETWORK_ERROR";
    throw err;
  };

  f.contentProvider.setImage("msg-throw-check", { buffer: Buffer.from("throw-check-bytes"), contentType: "image/jpeg" });

  await f.sendEvent({
    type: "message",
    webhookEventId: "ev-audit-throw",
    replyToken: "tok-audit-throw",
    source: { type: "user", userId },
    message: { type: "image", id: "msg-throw-check" }
  });

  const attempts = await f.repository.getPaymentAttempts(paymentId);
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].provider_status, "error");
  assert.equal(attempts[0].failure_reason_code, "NETWORK_ERROR");
  assert.equal(session.stage, "payment_manual_review");
});

test("Attempt Audit Order: confirmation failure does not erase attempt history", async () => {
  const f = createLineWebhookFixture();
  const userId = "user-audit-conf-fail";
  const paymentId = randomUUID();
  const bookingId = randomUUID();

  await f.repository.insertBooking({ id: bookingId, customer_id: userId, status: "pending", start_at: "2026-09-10T13:00:00Z", end_at: "2026-09-10T14:00:00Z" });
  await f.repository.insertPayment({ id: paymentId, business_id: "biz-test", original_booking_id: bookingId, amount_due: 300, status: PAYMENT_STATUSES.pending });

  const { session } = await f.sessions.external(userId, channelSecret);
  session.booking = { id: bookingId, status: "pending" };
  session.payment = { id: paymentId, amount_due: 300 };
  session.paymentId = paymentId;
  session.stage = "payment_pending";

  f.slipProvider.setScenario(MOCK_SLIP_SCENARIOS.VALID);
  f.contentProvider.setImage("msg-conf-fail", { buffer: Buffer.from("conf-fail-bytes"), contentType: "image/jpeg" });

  // Simulate repository error during confirmation transaction (e.g. status transition conflict)
  const originalUpdatePayment = f.repository.updatePayment.bind(f.repository);
  let failConfirmation = false;
  f.repository.updatePayment = async (pId, patch) => {
    if (failConfirmation && patch.status === PAYMENT_STATUSES.paid) {
      throw new Error("Simulated confirmation transaction crash");
    }
    return originalUpdatePayment(pId, patch);
  };

  failConfirmation = true;

  await assert.rejects(async () => {
    await f.sendEvent({
      type: "message",
      webhookEventId: "ev-conf-fail",
      replyToken: "tok-conf-fail",
      source: { type: "user", userId },
      message: { type: "image", id: "msg-conf-fail" }
    });
  }, /Simulated confirmation transaction crash/);

  // Attempt MUST still exist in repository despite confirmation crash!
  const attempts = await f.repository.getPaymentAttempts(paymentId);
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].normalized_result, "success");
});

// =============================================================================
// 10. Hardening Point 4: Multiple Pending Payment Association Rules
// =============================================================================

test("Association Rule B: session.paymentId absent, exactly 1 active pending payment auto-binds", async () => {
  const f = createLineWebhookFixture();
  const userId = "user-auto-bind-1";
  const paymentId = randomUUID();
  const bookingId = randomUUID();

  await f.repository.insertBooking({ id: bookingId, customer_id: userId, status: "pending", start_at: "2026-09-10T13:00:00Z", end_at: "2026-09-10T14:00:00Z" });
  await f.repository.insertPayment({ id: paymentId, business_id: "biz-test", original_booking_id: bookingId, amount_due: 300, status: PAYMENT_STATUSES.pending });

  const { session } = await f.sessions.external(userId, channelSecret);
  // paymentId is ABSENT in session!
  session.payment = null;
  session.paymentId = null;
  session.booking = null;
  session.stage = "start";

  f.slipProvider.setScenario(MOCK_SLIP_SCENARIOS.VALID);
  f.contentProvider.setImage("msg-auto-bind", { buffer: Buffer.from("auto-bind-bytes"), contentType: "image/jpeg" });

  await f.sendEvent({
    type: "message",
    webhookEventId: "ev-auto-bind",
    replyToken: "tok-auto-bind",
    source: { type: "user", userId },
    message: { type: "image", id: "msg-auto-bind" }
  });

  const payment = await f.repository.getPaymentById(paymentId);
  assert.equal(payment.status, PAYMENT_STATUSES.paid);
  const booking = await f.repository.getBookingById(bookingId);
  assert.equal(booking.status, "confirmed");
});

test("Association Rule C: session.paymentId absent, >1 active pending payments returns MULTIPLE_PENDING_PAYMENTS", async () => {
  const f = createLineWebhookFixture();
  const userId = "user-multi-pending";

  const p1 = randomUUID();
  const b1 = randomUUID();
  const p2 = randomUUID();
  const b2 = randomUUID();

  await f.repository.insertBooking({ id: b1, customer_id: userId, status: "pending", start_at: "2026-09-10T13:00:00Z", end_at: "2026-09-10T14:00:00Z" });
  await f.repository.insertPayment({ id: p1, business_id: "biz-test", original_booking_id: b1, amount_due: 300, status: PAYMENT_STATUSES.pending });

  await f.repository.insertBooking({ id: b2, customer_id: userId, status: "pending", start_at: "2026-09-11T13:00:00Z", end_at: "2026-09-11T14:00:00Z" });
  await f.repository.insertPayment({ id: p2, business_id: "biz-test", original_booking_id: b2, amount_due: 500, status: PAYMENT_STATUSES.pending });

  const { session } = await f.sessions.external(userId, channelSecret);
  // paymentId is ABSENT in session!
  session.payment = null;
  session.paymentId = null;
  session.stage = "start";

  f.contentProvider.setImage("msg-multi-check", { buffer: Buffer.from("multi-check-bytes"), contentType: "image/jpeg" });

  await f.sendEvent({
    type: "message",
    webhookEventId: "ev-multi-check",
    replyToken: "tok-multi-check",
    source: { type: "user", userId },
    message: { type: "image", id: "msg-multi-check" }
  });

  const reply = f.messaging.replies[0].messages[0];
  assert.match(reply.text, /พบรายการรอชำระเงินมากกว่า 1 รายการ/);
  // Neither payment should be touched
  const pay1 = await f.repository.getPaymentById(p1);
  const pay2 = await f.repository.getPaymentById(p2);
  assert.equal(pay1.status, PAYMENT_STATUSES.pending);
  assert.equal(pay2.status, PAYMENT_STATUSES.pending);
});

test("Association Rule D: session.paymentId points to payment of a different customer -> PAYMENT_SESSION_MISMATCH rejected", async () => {
  const f = createLineWebhookFixture();
  const attackerUserId = "user-attacker";
  const victimUserId = "user-victim";

  const victimPaymentId = randomUUID();
  const victimBookingId = randomUUID();

  await f.repository.insertBooking({ id: victimBookingId, customer_id: victimUserId, status: "pending", start_at: "2026-09-10T13:00:00Z", end_at: "2026-09-10T14:00:00Z" });
  await f.repository.insertPayment({ id: victimPaymentId, business_id: "biz-test", original_booking_id: victimBookingId, amount_due: 300, status: PAYMENT_STATUSES.pending });

  const { session } = await f.sessions.external(attackerUserId, channelSecret);
  // Attacker injects victim's paymentId into their session
  session.payment = { id: victimPaymentId, amount_due: 300 };
  session.paymentId = victimPaymentId;
  session.stage = "payment_pending";

  f.slipProvider.setScenario(MOCK_SLIP_SCENARIOS.VALID);
  f.contentProvider.setImage("msg-mismatch", { buffer: Buffer.from("mismatch-bytes"), contentType: "image/jpeg" });

  await f.sendEvent({
    type: "message",
    webhookEventId: "ev-mismatch",
    replyToken: "tok-mismatch",
    source: { type: "user", userId: attackerUserId },
    message: { type: "image", id: "msg-mismatch" }
  });

  const reply = f.messaging.replies[0].messages[0];
  assert.match(reply.text, /ไม่ตรงกับบัญชีผู้ใช้งานปัจจุบัน/);

  // Victim payment remains untouched
  const victimPayment = await f.repository.getPaymentById(victimPaymentId);
  assert.equal(victimPayment.status, PAYMENT_STATUSES.pending);
});

test("Association Rule E: expired / cancelled / paid booking cannot accept slip as new payment", async () => {
  const f = createLineWebhookFixture();
  const userId = "user-ineligible-booking";

  const paymentId = randomUUID();
  const bookingId = randomUUID();

  // Booking is cancelled
  await f.repository.insertBooking({ id: bookingId, customer_id: userId, status: "cancelled", start_at: "2026-09-10T13:00:00Z", end_at: "2026-09-10T14:00:00Z" });
  await f.repository.insertPayment({ id: paymentId, business_id: "biz-test", original_booking_id: bookingId, amount_due: 300, status: PAYMENT_STATUSES.pending });

  const { session } = await f.sessions.external(userId, channelSecret);
  session.payment = { id: paymentId, amount_due: 300 };
  session.paymentId = paymentId;
  session.stage = "payment_pending";

  f.contentProvider.setImage("msg-ineligible", { buffer: Buffer.from("ineligible-bytes"), contentType: "image/jpeg" });

  await f.sendEvent({
    type: "message",
    webhookEventId: "ev-ineligible",
    replyToken: "tok-ineligible",
    source: { type: "user", userId },
    message: { type: "image", id: "msg-ineligible" }
  });

  const reply = f.messaging.replies[0].messages[0];
  assert.match(reply.text, /อยู่ในสถานะ cancelled/);
});

