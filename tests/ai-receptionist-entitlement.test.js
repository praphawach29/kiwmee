const test = require("node:test");
const assert = require("node:assert/strict");

const { ToolGateway } = require("../src/ai/tools/gateway");
const { Receptionist } = require("../src/ai/receptionist");
const { MemorySessionStore } = require("../src/ai/sessions");
const { MockAIProvider } = require("../src/ai/provider");
const {
  FEATURES,
  StaticProvider,
  EntitlementService,
  DEFAULT_SINGLE_BUSINESS_ID,
  resetEntitlementService
} = require("../src/licensing");

const sid1 = "11111111-1111-4111-8111-111111111111";
const stid1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function createFixture() {
  const service = { id: sid1, name: "ตัดผมและจัดทรง (Haircut & Style)", price: "600", duration_minutes: 60 };
  const staff = { id: stid1, name: "ช่างกานต์" };
  const slotList = [
    { staff_id: stid1, start_at: "2026-09-10T13:00:00+07:00", end_at: "2026-09-10T14:00:00+07:00" }
  ];

  let createCalls = 0;
  const api = {
    services: async () => [service],
    staff: async () => [staff],
    availability: async () => ({ slots: slotList }),
    create: async (payload) => {
      createCalls++;
      return {
        id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        end_at: "2026-09-10T14:00:00+07:00",
        ...payload,
        status: "confirmed"
      };
    }
  };

  const gateway = new ToolGateway(api);
  const session = new MemorySessionStore().create();

  let interpretCalls = 0;
  const trackingProvider = {
    interpret: async (params) => {
      interpretCalls++;
      return new MockAIProvider().interpret(params);
    },
    get callCount() { return interpretCalls; },
    reset() { interpretCalls = 0; }
  };

  return { api, gateway, session, service, staff, trackingProvider, getCreateCalls: () => createCalls };
}

test("AI_PRO: AI provider interpret() CAN be called for natural language requests", async () => {
  resetEntitlementService();
  const f = createFixture();
  const provider = new StaticProvider({ defaultPackage: "AI_PRO" });
  const entService = new EntitlementService(provider);

  const receptionist = new Receptionist(f.gateway, f.trackingProvider, null, {
    entitlementService: entService,
    businessId: DEFAULT_SINGLE_BUSINESS_ID
  });

  const res = await receptionist.respond(f.session, "ตัดผมพรุ่งนี้บ่าย");
  assert.equal(f.trackingProvider.callCount, 1);
  assert.ok(res.message);
});

test("PRO: AI provider interpret() is STRICTLY BLOCKED (call count = 0) on natural language", async () => {
  resetEntitlementService();
  const f = createFixture();
  const provider = new StaticProvider({ defaultPackage: "PRO" });
  const entService = new EntitlementService(provider);

  const receptionist = new Receptionist(f.gateway, f.trackingProvider, null, {
    entitlementService: entService,
    businessId: DEFAULT_SINGLE_BUSINESS_ID
  });

  // Natural language query that would normally invoke LLM inference
  const res = await receptionist.respond(f.session, "มีที่จอดรถไหมคะ ร้านเปิดกี่โมง");

  // Verify server-layer prevention: provider must NOT be called at all
  assert.equal(f.trackingProvider.callCount, 0);

  // Friendly deterministic fallback response
  assert.match(res.message, /ขออภัยค่ะ/);
  assert.match(res.message, /ติดต่อร้าน/);
  assert.ok(res.choices.length > 0);
  assert.equal(res.state.stage, "service");
});

test("PRO: full deterministic booking flow completes with call count = 0 throughout", async () => {
  resetEntitlementService();
  const f = createFixture();
  const provider = new StaticProvider({ defaultPackage: "PRO" });
  const entService = new EntitlementService(provider);

  const receptionist = new Receptionist(f.gateway, f.trackingProvider, null, {
    entitlementService: entService,
    businessId: DEFAULT_SINGLE_BUSINESS_ID
  });

  // 1. Start via postback
  const res1 = await receptionist.respond(f.session, "action=start");
  assert.equal(res1.state.stage, "service");
  assert.equal(f.trackingProvider.callCount, 0);

  // 2. Select service via postback
  const res2 = await receptionist.respond(f.session, `action=service&service_id=${f.service.id}`);
  assert.equal(res2.state.stage, "staff");
  assert.equal(f.trackingProvider.callCount, 0);

  // 3. Select staff via postback
  const res3 = await receptionist.respond(f.session, `action=staff&staff_id=${f.staff.id}`);
  assert.equal(res3.state.stage, "date");
  assert.equal(f.trackingProvider.callCount, 0);

  // 4. Select date via postback
  const res4 = await receptionist.respond(f.session, "action=date&date=today");
  assert.equal(res4.state.stage, "slot");
  assert.equal(f.trackingProvider.callCount, 0);

  // 5. Select slot via postback
  const res5 = await receptionist.respond(f.session, `action=slot&staff_id=${f.staff.id}&start_at=${encodeURIComponent("2026-09-10T13:00:00+07:00")}`);
  assert.equal(res5.state.stage, "contact");
  assert.equal(f.trackingProvider.callCount, 0);

  // 6. Enter customer contact info
  const res6 = await receptionist.respond(f.session, "สุรีย์พร 0812345678");
  assert.equal(res6.state.stage, "review");
  assert.equal(f.trackingProvider.callCount, 0);

  // 7. Confirm booking
  const res7 = await receptionist.respond(f.session, "action=confirm");
  assert.equal(res7.state.stage, "success");
  assert.equal(f.getCreateCalls(), 1);
  assert.equal(f.trackingProvider.callCount, 0);
});

test("BASIC: AI provider interpret() is BLOCKED and text booking flow functions normally", async () => {
  resetEntitlementService();
  const f = createFixture();
  const provider = new StaticProvider({ defaultPackage: "BASIC" });
  const entService = new EntitlementService(provider);

  const receptionist = new Receptionist(f.gateway, f.trackingProvider, null, {
    entitlementService: entService,
    businessId: DEFAULT_SINGLE_BUSINESS_ID
  });

  // Natural language query blocked
  const nlRes = await receptionist.respond(f.session, "อยากทราบโปรโมชั่นทำผม");
  assert.equal(f.trackingProvider.callCount, 0);
  assert.match(nlRes.message, /ขออภัยค่ะ/);

  // Direct service selection by name (deterministic)
  const serviceRes = await receptionist.respond(f.session, "ตัดผมและจัดทรง");
  assert.equal(serviceRes.state.stage, "staff");
  assert.equal(f.trackingProvider.callCount, 0);

  // Direct staff selection by name (deterministic)
  const staffRes = await receptionist.respond(f.session, "ช่างกานต์");
  assert.equal(staffRes.state.stage, "date");
  assert.equal(f.trackingProvider.callCount, 0);

  // Direct date selection
  const dateRes = await receptionist.respond(f.session, "2026-09-10");
  assert.equal(dateRes.state.stage, "slot");
  assert.equal(f.trackingProvider.callCount, 0);

  // Direct slot selection
  const slotRes = await receptionist.respond(f.session, "1");
  assert.equal(slotRes.state.stage, "contact");
  assert.equal(f.trackingProvider.callCount, 0);

  // Contact info
  const contactRes = await receptionist.respond(f.session, "กานดา 0891234567");
  assert.equal(contactRes.state.stage, "review");
  assert.equal(f.trackingProvider.callCount, 0);

  // Confirm
  const confirmRes = await receptionist.respond(f.session, "ยืนยัน");
  assert.equal(confirmRes.state.stage, "success");
  assert.equal(f.getCreateCalls(), 1);
  assert.equal(f.trackingProvider.callCount, 0); // 0 calls across entire text flow!
});

test("Entitlement provider error causes AI to fail closed without crashing booking flow", async () => {
  resetEntitlementService();
  const f = createFixture();

  // Provider that throws an error
  const crashingProvider = {
    async getBusinessEntitlements() {
      throw new Error("License server internal 500");
    }
  };
  const entService = new EntitlementService(crashingProvider);

  const receptionist = new Receptionist(f.gateway, f.trackingProvider, null, {
    entitlementService: entService,
    businessId: DEFAULT_SINGLE_BUSINESS_ID
  });

  // Natural language query when entitlement service has an error
  const res = await receptionist.respond(f.session, "ร้านมีที่จอดรถไหมคะ");

  // Provider must NOT be called (fail closed)
  assert.equal(f.trackingProvider.callCount, 0);

  // Friendly fallback, no crash
  assert.ok(res.message);
  assert.match(res.message, /ขออภัยค่ะ/);
  assert.ok(res.choices.length > 0);
});

test("Default runtime configuration defaults to AI_PRO preserving current production behavior", async () => {
  resetEntitlementService();
  const f = createFixture();

  // Default receptionist without explicit entitlement service uses global default (AI_PRO)
  const receptionist = new Receptionist(f.gateway, f.trackingProvider);

  await receptionist.respond(f.session, "ตัดผมพรุ่งนี้บ่าย");
  assert.equal(f.trackingProvider.callCount, 1);
});
