const test = require("node:test");
const assert = require("node:assert/strict");
const { createHmac } = require("node:crypto");

const { ToolGateway } = require("../src/ai/tools/gateway");
const { Receptionist } = require("../src/ai/receptionist");
const { MemorySessionStore } = require("../src/ai/sessions");
const { MockAIProvider } = require("../src/ai/provider");
const { LineWebhookService, formatLineReply, formatLineReplyWithEntitlement } = require("../src/messaging/line-webhook-service");
const { MockMessagingProvider } = require("../src/messaging/providers");
const { MemoryRateLimiter } = require("../src/security/limits");
const {
  FEATURES,
  StaticProvider,
  EntitlementService,
  DEFAULT_SINGLE_BUSINESS_ID,
  resetEntitlementService
} = require("../src/licensing");

const sid = "11111111-1111-4111-8111-111111111111";
const staffId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const staff2Id = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function createFixture() {
  const service = { id: sid, name: "ดีท็อกซ์หนังศีรษะ", price: "950", duration_minutes: 60 };
  const staff1 = { id: staffId, name: "ช่างกานต์" };
  const staff2 = { id: staff2Id, name: "ช่างแอน" };
  const slotList = [
    { staff_id: staffId, start_at: "2026-09-10T13:00:00+07:00", end_at: "2026-09-10T14:00:00+07:00" },
    { staff_id: staff2Id, start_at: "2026-09-10T14:00:00+07:00", end_at: "2026-09-10T15:00:00+07:00" }
  ];

  const api = {
    services: async () => [service],
    staff: async () => [staff1, staff2],
    availability: async ({ staff_id }) => ({
      slots: slotList.filter((s) => !staff_id || s.staff_id === staff_id)
    }),
    create: async (payload) => ({
      id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      end_at: "2026-09-10T14:00:00+07:00",
      ...payload,
      status: "confirmed"
    })
  };

  const gateway = new ToolGateway(api);
  const receptionist = new Receptionist(gateway, new MockAIProvider());
  const session = new MemorySessionStore().create();

  return { api, gateway, receptionist, session, service, staff1, staff2 };
}

function createWebhookRunner(fixture, { entitlementService = null, hasFeatureFn = null, businessId = DEFAULT_SINGLE_BUSINESS_ID } = {}) {
  const messaging = new MockMessagingProvider("test-secret");
  const sessions = {
    external: async (userId) => ({ session: fixture.session, owner: userId }),
    withSession: async (id, owner, fn) => fn(fixture.session)
  };
  const repository = {
    claimed: new Set(),
    claimLineEvent: async (id) => {
      if (repository.claimed.has(id)) return false;
      repository.claimed.add(id);
      return true;
    },
    completeLineEvent: async () => {},
    failLineEvent: async () => {}
  };
  const limiter = new MemoryRateLimiter();

  const service = new LineWebhookService({
    messaging,
    sessions,
    receptionist: fixture.receptionist,
    repository,
    limiter,
    channelSecret: "test-secret",
    businessId,
    entitlementService,
    hasFeatureFn
  });

  let seq = 0;
  const sendEvent = async (eventObj) => {
    const raw = JSON.stringify({ events: [eventObj] });
    const sig = createHmac("sha256", "test-secret").update(raw).digest("base64");
    return service.handle(raw, sig);
  };

  return { messaging, service, sendEvent, nextSeq: () => ++seq };
}

test("AI_PRO preset enables LINE Flex Message in LineWebhookService", async () => {
  resetEntitlementService();
  const f = createFixture();
  const provider = new StaticProvider({ defaultPackage: "AI_PRO" });
  const entService = new EntitlementService(provider);

  const runner = createWebhookRunner(f, { entitlementService: entService });
  const seq = runner.nextSeq();

  await runner.sendEvent({
    type: "message",
    webhookEventId: `ev-${seq}`,
    replyToken: `tok-${seq}`,
    source: { type: "user", userId: "U-line-pro-user" },
    message: { type: "text", text: "บริการ" }
  });

  assert.equal(runner.messaging.replies.length, 1);
  const sentReply = runner.messaging.replies[0].messages[0];
  assert.equal(sentReply.type, "flex");
  assert.equal(sentReply.contents.type, "carousel");
  assert.ok(sentReply.altText.includes("บริการ"));
  assert.ok(sentReply.quickReply.items.length > 0);
});

test("PRO preset enables LINE Flex Message in LineWebhookService", async () => {
  resetEntitlementService();
  const f = createFixture();
  const provider = new StaticProvider({ defaultPackage: "PRO" });
  const entService = new EntitlementService(provider);

  const runner = createWebhookRunner(f, { entitlementService: entService });
  const seq = runner.nextSeq();

  await runner.sendEvent({
    type: "message",
    webhookEventId: `ev-${seq}`,
    replyToken: `tok-${seq}`,
    source: { type: "user", userId: "U-line-pro-user" },
    message: { type: "text", text: "บริการ" }
  });

  assert.equal(runner.messaging.replies.length, 1);
  const sentReply = runner.messaging.replies[0].messages[0];
  assert.equal(sentReply.type, "flex");
  assert.equal(sentReply.contents.type, "carousel");
});

test("BASIC preset falls back to Text + Quick Reply in LineWebhookService", async () => {
  resetEntitlementService();
  const f = createFixture();
  const provider = new StaticProvider({ defaultPackage: "BASIC" });
  const entService = new EntitlementService(provider);

  const runner = createWebhookRunner(f, { entitlementService: entService });
  const seq = runner.nextSeq();

  await runner.sendEvent({
    type: "message",
    webhookEventId: `ev-${seq}`,
    replyToken: `tok-${seq}`,
    source: { type: "user", userId: "U-line-basic-user" },
    message: { type: "text", text: "บริการ" }
  });

  assert.equal(runner.messaging.replies.length, 1);
  const sentReply = runner.messaging.replies[0].messages[0];
  assert.equal(sentReply.type, "text");
  assert.equal(sentReply.contents, undefined);
  assert.ok(sentReply.text.includes("เลือกบริการ"));
  assert.ok(sentReply.quickReply.items.length > 0);
  assert.equal(sentReply.quickReply.items[0].action.type, "postback");
});

test("BASIC preset executes full 7-turn booking flow using Text + Quick Reply fallback without errors", async () => {
  resetEntitlementService();
  const f = createFixture();
  const provider = new StaticProvider({ defaultPackage: "BASIC" });
  const entService = new EntitlementService(provider);

  const runner = createWebhookRunner(f, { entitlementService: entService });
  const user = "U-line-basic-flow";

  // Turn 1: User requests services
  let seq = runner.nextSeq();
  await runner.sendEvent({
    type: "message",
    webhookEventId: `ev-${seq}`,
    replyToken: `tok-${seq}`,
    source: { type: "user", userId: user },
    message: { type: "text", text: "บริการ" }
  });
  let rep = runner.messaging.replies[0].messages[0];
  assert.equal(rep.type, "text");
  assert.ok(rep.quickReply.items.some((i) => i.action.data.startsWith("action=service")));

  // Turn 2: User selects service via postback
  seq = runner.nextSeq();
  await runner.sendEvent({
    type: "postback",
    webhookEventId: `ev-${seq}`,
    replyToken: `tok-${seq}`,
    source: { type: "user", userId: user },
    postback: { data: `action=service&service_id=${sid}` }
  });
  rep = runner.messaging.replies[1].messages[0];
  assert.equal(rep.type, "text");
  assert.ok(rep.text.includes("เลือกช่าง"));
  assert.ok(rep.quickReply.items.some((i) => i.action.data.startsWith("action=staff")));

  // Turn 3: User selects ANY_STAFF
  seq = runner.nextSeq();
  await runner.sendEvent({
    type: "postback",
    webhookEventId: `ev-${seq}`,
    replyToken: `tok-${seq}`,
    source: { type: "user", userId: user },
    postback: { data: "action=staff&staff_id=ANY_STAFF" }
  });
  rep = runner.messaging.replies[2].messages[0];
  assert.equal(rep.type, "text");
  assert.match(rep.text, /ต้องการวันไหน/);
  assert.ok(rep.quickReply.items.some((i) => i.action.type === "datetimepicker"));

  // Turn 4: User selects today
  seq = runner.nextSeq();
  await runner.sendEvent({
    type: "postback",
    webhookEventId: `ev-${seq}`,
    replyToken: `tok-${seq}`,
    source: { type: "user", userId: user },
    postback: { data: "action=date&date=today" }
  });
  rep = runner.messaging.replies[3].messages[0];
  assert.equal(rep.type, "text");
  assert.match(rep.text, /เลือกเวลาที่ต้องการ/);
  assert.ok(rep.quickReply.items.some((i) => i.action.data.startsWith("action=slot")));

  // Turn 5: User selects slot
  seq = runner.nextSeq();
  const slotData = rep.quickReply.items[0].action.data;
  await runner.sendEvent({
    type: "postback",
    webhookEventId: `ev-${seq}`,
    replyToken: `tok-${seq}`,
    source: { type: "user", userId: user },
    postback: { data: slotData }
  });
  rep = runner.messaging.replies[4].messages[0];
  assert.equal(rep.type, "text");
  assert.match(rep.text, /ขอชื่อและเบอร์โทร/);

  // Turn 6: User sends contact info
  seq = runner.nextSeq();
  await runner.sendEvent({
    type: "message",
    webhookEventId: `ev-${seq}`,
    replyToken: `tok-${seq}`,
    source: { type: "user", userId: user },
    message: { type: "text", text: "วรรณา 0899998888" }
  });
  rep = runner.messaging.replies[5].messages[0];
  assert.equal(rep.type, "text");
  assert.match(rep.text, /บริการ:/);
  assert.match(rep.text, /ตรวจสอบ/);
  const confirmBtn = rep.quickReply.items.find((i) => i.action.label === "ยืนยันการจอง");
  assert.ok(confirmBtn);

  // Turn 7: User confirms booking
  seq = runner.nextSeq();
  await runner.sendEvent({
    type: "postback",
    webhookEventId: `ev-${seq}`,
    replyToken: `tok-${seq}`,
    source: { type: "user", userId: user },
    postback: { data: confirmBtn.action.data }
  });
  rep = runner.messaging.replies[6].messages[0];
  assert.equal(rep.type, "text");
  assert.match(rep.text, /จองสำเร็จ/);
  assert.match(rep.text, /รหัสนัด:/);
  assert.match(rep.text, /สถานะ: confirmed/);
});

test("provider error triggers safe fallback to Text + Quick Reply without halting", async () => {
  resetEntitlementService();
  const f = createFixture();

  // Custom provider that always fails
  const failingProvider = {
    async getBusinessEntitlements() {
      throw new Error("License server timeout");
    }
  };
  const entService = new EntitlementService(failingProvider);

  const runner = createWebhookRunner(f, { entitlementService: entService });
  const seq = runner.nextSeq();

  // Webhook event should succeed and safely fall back to text message
  await runner.sendEvent({
    type: "message",
    webhookEventId: `ev-${seq}`,
    replyToken: `tok-${seq}`,
    source: { type: "user", userId: "U-line-error-user" },
    message: { type: "text", text: "บริการ" }
  });

  assert.equal(runner.messaging.replies.length, 1);
  const sentReply = runner.messaging.replies[0].messages[0];
  assert.equal(sentReply.type, "text");
  assert.ok(sentReply.text.includes("เลือกบริการ"));
  assert.ok(sentReply.quickReply.items.length > 0);
});

test("formatLineReply strictly fails closed: only hasFlex === true produces Flex, all others fallback to Text", async () => {
  const f = createFixture();
  const res = await f.receptionist.respond(f.session, "action=start");

  // hasFlex: true returns flex
  const flexReply = formatLineReply(res, { hasFlex: true });
  assert.equal(flexReply.type, "flex");
  assert.equal(flexReply.contents.type, "carousel");

  // hasFlex: false returns text
  const falseReply = formatLineReply(res, { hasFlex: false });
  assert.equal(falseReply.type, "text");
  assert.equal(falseReply.contents, undefined);
  assert.ok(falseReply.text.length > 0);
  assert.ok(falseReply.quickReply.items.length > 0);

  // hasFlex: undefined returns text (fail closed)
  const undefinedReply = formatLineReply(res, { hasFlex: undefined });
  assert.equal(undefinedReply.type, "text");
  assert.equal(undefinedReply.contents, undefined);

  // hasFlex: null returns text (fail closed)
  const nullReply = formatLineReply(res, { hasFlex: null });
  assert.equal(nullReply.type, "text");
  assert.equal(nullReply.contents, undefined);

  // default without options returns text (fail closed)
  const defaultReply = formatLineReply(res);
  assert.equal(defaultReply.type, "text");
  assert.equal(defaultReply.contents, undefined);
});

test("formatLineReplyWithEntitlement resolves capability asynchronously", async () => {
  const f = createFixture();
  const res = await f.receptionist.respond(f.session, "action=start");

  const basicProvider = new StaticProvider({ defaultPackage: "BASIC" });
  const basicService = new EntitlementService(basicProvider);
  const replyBasic = await formatLineReplyWithEntitlement(res, { entitlementService: basicService });
  assert.equal(replyBasic.type, "text");

  const proProvider = new StaticProvider({ defaultPackage: "PRO" });
  const proService = new EntitlementService(proProvider);
  const replyPro = await formatLineReplyWithEntitlement(res, { entitlementService: proService });
  assert.equal(replyPro.type, "flex");
});
