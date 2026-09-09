const test = require("node:test");
const assert = require("node:assert/strict");
const { createHmac } = require("node:crypto");

const { ToolGateway } = require("../src/ai/tools/gateway");
const { Receptionist, getBangkokDate } = require("../src/ai/receptionist");
const { MemorySessionStore } = require("../src/ai/sessions");
const { MockAIProvider } = require("../src/ai/provider");
const { LineWebhookService, formatLineReply } = require("../src/messaging/line-webhook-service");
const { MockMessagingProvider } = require("../src/messaging/providers");
const { MemoryRateLimiter } = require("../src/security/limits");

const sid = "11111111-1111-4111-8111-111111111111";
const staffId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const staff2Id = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function createFixture() {
  const service = { id: sid, name: "ดีท็อกซ์หนังศีรษะ", price: "950", duration_minutes: 60 };
  const staff1 = { id: staffId, name: "ช่างกานต์" };
  const staff2 = { id: staff2Id, name: "ช่างแอน" };
  let slotList = [
    { staff_id: staffId, start_at: "2026-09-10T13:00:00+07:00", end_at: "2026-09-10T14:00:00+07:00" },
    { staff_id: staff2Id, start_at: "2026-09-10T14:00:00+07:00", end_at: "2026-09-10T15:00:00+07:00" }
  ];
  let createCount = 0;
  let availabilityCount = 0;

  const api = {
    services: async () => [service],
    staff: async (id) => [staff1, staff2],
    availability: async ({ date, staff_id }) => {
      availabilityCount++;
      const filtered = slotList.filter((s) => !staff_id || s.staff_id === staff_id);
      return { slots: filtered };
    },
    create: async (payload) => {
      createCount++;
      return {
        id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        end_at: "2026-09-10T14:00:00+07:00",
        ...payload,
        status: "confirmed"
      };
    }
  };

  const gateway = new ToolGateway(api);
  const receptionist = new Receptionist(gateway, new MockAIProvider());
  const session = new MemorySessionStore().create();

  return {
    api,
    gateway,
    receptionist,
    session,
    service,
    staff1,
    staff2,
    getSlotList: () => slotList,
    setSlotList: (slots) => { slotList = slots; },
    getCreateCount: () => createCount,
    getAvailabilityCount: () => availabilityCount
  };
}

test("service postback success", async () => {
  const f = createFixture();
  const init = await f.receptionist.respond(f.session, "บริการ");
  assert.equal(init.state.stage, "service");

  const res = await f.receptionist.respond(f.session, `action=service&service_id=${sid}`);
  assert.equal(res.state.stage, "staff");
  assert.equal(f.session.service.id, sid);
  assert.equal(res.choices.length, 3); // staff1, staff2, ANY_STAFF
  assert.ok(res.choices.some((c) => c.postbackData === "action=staff&staff_id=ANY_STAFF"));
});

test("stale service postback rejected and recovered", async () => {
  const f = createFixture();
  await f.receptionist.respond(f.session, "บริการ");
  await f.receptionist.respond(f.session, `action=service&service_id=${sid}`);
  assert.equal(f.session.stage, "staff");

  // User clicks stale service button while at staff stage
  const res = await f.receptionist.respond(f.session, `action=service&service_id=other-id`);
  assert.equal(res.state.stage, "staff"); // Still at staff stage
  assert.equal(f.session.service.id, sid); // Service not overwritten
  assert.ok(res.choices.some((c) => c.postbackData.includes("action=staff")));
});

test("staff postback success", async () => {
  const f = createFixture();
  await f.receptionist.respond(f.session, "บริการ");
  await f.receptionist.respond(f.session, `action=service&service_id=${sid}`);

  const res = await f.receptionist.respond(f.session, `action=staff&staff_id=${staffId}`);
  assert.equal(res.state.stage, "date");
  assert.equal(f.session.staff.id, staffId);
  assert.equal(res.choices.length, 3); // วันนี้, พรุ่งนี้, เลือกวันที่อื่น
  assert.ok(res.choices.some((c) => c.postbackData === "action=date&date=today"));
  assert.ok(res.choices.some((c) => c.postbackData === "action=date&date=tomorrow"));
  assert.ok(res.choices.some((c) => c.type === "datetimepicker"));
});

test("ANY_STAFF postback option", async () => {
  const f = createFixture();
  await f.receptionist.respond(f.session, "บริการ");
  await f.receptionist.respond(f.session, `action=service&service_id=${sid}`);

  const res = await f.receptionist.respond(f.session, "action=staff&staff_id=ANY_STAFF");
  assert.equal(res.state.stage, "date");
  assert.equal(f.session.staff, null); // ANY_STAFF sets staff to null for availability search
  assert.equal(res.choices.length, 3);
});

test("today date postback", async () => {
  const f = createFixture();
  await f.receptionist.respond(f.session, "บริการ");
  await f.receptionist.respond(f.session, `action=service&service_id=${sid}`);
  await f.receptionist.respond(f.session, "action=staff&staff_id=ANY_STAFF");

  const res = await f.receptionist.respond(f.session, "action=date&date=today");
  assert.equal(res.state.stage, "slot");
  assert.equal(f.session.date, getBangkokDate(0));
  assert.ok(res.choices.length > 0);
});

test("tomorrow date postback", async () => {
  const f = createFixture();
  await f.receptionist.respond(f.session, "บริการ");
  await f.receptionist.respond(f.session, `action=service&service_id=${sid}`);
  await f.receptionist.respond(f.session, "action=staff&staff_id=ANY_STAFF");

  const res = await f.receptionist.respond(f.session, "action=date&date=tomorrow");
  assert.equal(res.state.stage, "slot");
  assert.equal(f.session.date, getBangkokDate(1));
  assert.ok(res.choices.length > 0);
});

test("date picker postback", async () => {
  const f = createFixture();
  await f.receptionist.respond(f.session, "บริการ");
  await f.receptionist.respond(f.session, `action=service&service_id=${sid}`);
  await f.receptionist.respond(f.session, "action=staff&staff_id=ANY_STAFF");

  const res = await f.receptionist.respond(f.session, "action=date_picker&date=2026-09-10");
  assert.equal(res.state.stage, "slot");
  assert.equal(f.session.date, "2026-09-10");
  assert.equal(res.choices.length, 2);
});

test("DD/MM/YYYY text fallback", async () => {
  const f = createFixture();
  await f.receptionist.respond(f.session, "บริการ");
  await f.receptionist.respond(f.session, `action=service&service_id=${sid}`);
  await f.receptionist.respond(f.session, "action=staff&staff_id=ANY_STAFF");

  const res = await f.receptionist.respond(f.session, "10/09/2026");
  assert.equal(res.state.stage, "slot");
  assert.equal(f.session.date, "2026-09-10");
});

test("DD-MM-YYYY text fallback", async () => {
  const f = createFixture();
  await f.receptionist.respond(f.session, "บริการ");
  await f.receptionist.respond(f.session, `action=service&service_id=${sid}`);
  await f.receptionist.respond(f.session, "action=staff&staff_id=ANY_STAFF");

  const res = await f.receptionist.respond(f.session, "10-09-2026");
  assert.equal(res.state.stage, "slot");
  assert.equal(f.session.date, "2026-09-10");
});

test("invalid date recoverable without generic error", async () => {
  const f = createFixture();
  await f.receptionist.respond(f.session, "บริการ");
  await f.receptionist.respond(f.session, `action=service&service_id=${sid}`);
  await f.receptionist.respond(f.session, "action=staff&staff_id=ANY_STAFF");

  const res = await f.receptionist.respond(f.session, "31/02/2026");
  assert.equal(res.state.stage, "date");
  assert.match(res.message, /รูปแบบวันที่ไม่ถูกต้อง/);
  assert.equal(res.choices.length, 3); // Date quick reply choices offered again
});

test("slot postback success", async () => {
  const f = createFixture();
  await f.receptionist.respond(f.session, "บริการ");
  await f.receptionist.respond(f.session, `action=service&service_id=${sid}`);
  await f.receptionist.respond(f.session, "action=staff&staff_id=ANY_STAFF");
  const slotRes = await f.receptionist.respond(f.session, "action=date_picker&date=2026-09-10");

  const slotChoice = slotRes.choices[0];
  const res = await f.receptionist.respond(f.session, slotChoice.postbackData);
  assert.equal(res.state.stage, "contact");
  assert.equal(f.session.slot.start_at, "2026-09-10T13:00:00+07:00");
  assert.match(res.message, /ขอชื่อและเบอร์โทร/);
});

test("stale slot refresh when requested slot is no longer available", async () => {
  const f = createFixture();
  await f.receptionist.respond(f.session, "บริการ");
  await f.receptionist.respond(f.session, `action=service&service_id=${sid}`);
  await f.receptionist.respond(f.session, "action=staff&staff_id=ANY_STAFF");
  await f.receptionist.respond(f.session, "action=date_picker&date=2026-09-10");

  // Someone else books the first slot:
  f.setSlotList([
    { staff_id: staff2Id, start_at: "2026-09-10T14:00:00+07:00", end_at: "2026-09-10T15:00:00+07:00" }
  ]);

  // User taps the now-stale slot button:
  const res = await f.receptionist.respond(f.session, `action=slot&staff_id=${staffId}&start_at=${encodeURIComponent("2026-09-10T13:00:00+07:00")}`);
  assert.equal(res.state.stage, "slot");
  assert.equal(f.session.slot, null);
  assert.match(res.message, /เวลานี้เพิ่งถูกจองไปค่ะ กรุณาเลือกเวลาใหม่/);
  assert.equal(res.choices.length, 1);
  assert.equal(res.choices[0].value, `${staff2Id} 2026-09-10T14:00:00+07:00`);
});

test("confirmation required and duplicate confirm does not create twice", async () => {
  const f = createFixture();
  await f.receptionist.respond(f.session, "บริการ");
  await f.receptionist.respond(f.session, `action=service&service_id=${sid}`);
  await f.receptionist.respond(f.session, "action=staff&staff_id=ANY_STAFF");
  await f.receptionist.respond(f.session, "action=date_picker&date=2026-09-10");
  await f.receptionist.respond(f.session, `action=slot&staff_id=${staffId}&start_at=${encodeURIComponent("2026-09-10T13:00:00+07:00")}`);
  const reviewRes = await f.receptionist.respond(f.session, "กานต์ ช่างผม 0812345678");

  assert.equal(reviewRes.state.stage, "review");
  assert.equal(f.getCreateCount(), 0);

  // Confirm button click:
  const confirmChoice = reviewRes.choices.find((c) => c.postbackData?.startsWith("action=confirm"));
  assert.ok(confirmChoice);

  const bookedRes = await f.receptionist.respond(f.session, confirmChoice.postbackData);
  assert.equal(bookedRes.state.stage, "success");
  assert.equal(f.getCreateCount(), 1);
  assert.match(bookedRes.message, /จองสำเร็จ/);

  // Duplicate confirm clicked:
  const dupRes = await f.receptionist.respond(f.session, confirmChoice.postbackData);
  assert.equal(dupRes.state.stage, "success");
  assert.equal(f.getCreateCount(), 1); // No second booking created!
  assert.match(dupRes.message, /ได้รับการยืนยันเรียบร้อยแล้ว/);
});

test("restart and cancel flow", async () => {
  const f = createFixture();
  await f.receptionist.respond(f.session, "บริการ");
  await f.receptionist.respond(f.session, `action=service&service_id=${sid}`);
  await f.receptionist.respond(f.session, "action=staff&staff_id=ANY_STAFF");
  assert.equal(f.session.stage, "date");

  // Restart
  const restartRes = await f.receptionist.respond(f.session, "action=restart");
  assert.equal(restartRes.state.stage, "service");
  assert.equal(f.session.service, null);

  // Cancel
  const cancelRes = await f.receptionist.respond(f.session, "action=cancel");
  assert.equal(cancelRes.state.stage, "service");
  assert.match(cancelRes.message, /ยกเลิกรายการเรียบร้อย/);
});

test("quick reply overflow pagination", async () => {
  // 20 services fixture
  const services = Array.from({ length: 20 }, (_, i) => ({
    id: `00000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`,
    name: `บริการที่ ${i + 1}`,
    price: "500",
    duration_minutes: 30
  }));

  const api = {
    services: async () => services,
    staff: async () => [],
    availability: async () => ({ slots: [] }),
    create: async () => ({ id: "00000000-0000-4000-8000-000000000001" })
  };

  const gateway = new ToolGateway(api);
  const receptionist = new Receptionist(gateway, new MockAIProvider());
  const session = new MemorySessionStore().create();

  const res1 = await receptionist.respond(session, "บริการ");
  assert.equal(res1.choices.length, 13); // Max 13 quick reply items
  const moreBtn = res1.choices[12];
  assert.equal(moreBtn.value, "ดูเพิ่ม");
  assert.equal(moreBtn.postbackData, "action=more&offset=12");

  // formatLineReply check
  const lineReply = formatLineReply(res1);
  assert.equal(lineReply.quickReply.items.length, 13);
  assert.match(lineReply.text, /มีทั้งหมด 20 รายการ/);

  // Next page
  const res2 = await receptionist.respond(session, "action=more&offset=12");
  assert.ok(res2.choices.length > 0);
  assert.ok(res2.choices.some((c) => c.value === "ก่อนหน้า"));
});

test("LINE booking flow end-to-end via LineWebhookService with signature", async () => {
  const f = createFixture();
  const messaging = new MockMessagingProvider("test-channel-secret");
  const sessions = {
    external: async (userId, secret) => ({ session: f.session, owner: userId }),
    withSession: async (id, owner, fn) => fn(f.session)
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
    receptionist: f.receptionist,
    repository,
    limiter,
    channelSecret: "test-channel-secret"
  });

  const sendWebhook = async (eventObj) => {
    const raw = JSON.stringify({ events: [eventObj] });
    const sig = createHmac("sha256", "test-channel-secret").update(raw).digest("base64");
    return service.handle(raw, sig);
  };

  let seq = 0;
  const user = "U-test-line-customer";

  // Turn 1: User sends text "บริการ"
  await sendWebhook({
    type: "message",
    webhookEventId: `ev-${++seq}`,
    replyToken: `tok-${seq}`,
    source: { type: "user", userId: user },
    message: { type: "text", text: "บริการ" }
  });
  assert.equal(messaging.replies.length, 1);
  assert.match(messaging.replies[0].messages[0].text, /เลือกบริการที่ต้องการ/);
  assert.ok(messaging.replies[0].messages[0].quickReply.items.length > 0);

  // Turn 2: User clicks service button (postback)
  await sendWebhook({
    type: "postback",
    webhookEventId: `ev-${++seq}`,
    replyToken: `tok-${seq}`,
    source: { type: "user", userId: user },
    postback: { data: `action=service&service_id=${sid}` }
  });
  assert.equal(messaging.replies.length, 2);
  assert.match(messaging.replies[1].messages[0].text, /เลือกช่างที่ต้องการ/);
  assert.ok(messaging.replies[1].messages[0].quickReply.items.some((i) => i.action.label === "ใครก็ได้"));

  // Turn 3: User clicks ANY_STAFF
  await sendWebhook({
    type: "postback",
    webhookEventId: `ev-${++seq}`,
    replyToken: `tok-${seq}`,
    source: { type: "user", userId: user },
    postback: { data: "action=staff&staff_id=ANY_STAFF" }
  });
  assert.equal(messaging.replies.length, 3);
  assert.match(messaging.replies[2].messages[0].text, /ต้องการวันไหนคะ/);
  // Has datetimepicker in quick replies
  assert.ok(messaging.replies[2].messages[0].quickReply.items.some((i) => i.action.type === "datetimepicker"));

  // Turn 4: User picks date via datetimepicker postback
  await sendWebhook({
    type: "postback",
    webhookEventId: `ev-${++seq}`,
    replyToken: `tok-${seq}`,
    source: { type: "user", userId: user },
    postback: {
      data: "action=date_picker",
      params: { date: "2026-09-10" }
    }
  });
  assert.equal(messaging.replies.length, 4);
  assert.match(messaging.replies[3].messages[0].text, /เลือกเวลาที่ต้องการ/);

  // Turn 5: User clicks slot button (postback)
  await sendWebhook({
    type: "postback",
    webhookEventId: `ev-${++seq}`,
    replyToken: `tok-${seq}`,
    source: { type: "user", userId: user },
    postback: { data: `action=slot&staff_id=${staffId}&start_at=${encodeURIComponent("2026-09-10T13:00:00+07:00")}` }
  });
  assert.equal(messaging.replies.length, 5);
  assert.match(messaging.replies[4].messages[0].text, /ขอชื่อและเบอร์โทร/);

  // Turn 6: User enters contact info as text
  await sendWebhook({
    type: "message",
    webhookEventId: `ev-${++seq}`,
    replyToken: `tok-${seq}`,
    source: { type: "user", userId: user },
    message: { type: "text", text: "กานต์ วารี 0891234567" }
  });
  assert.equal(messaging.replies.length, 6);
  assert.match(messaging.replies[5].messages[0].text, /ตรวจสอบรายละเอียด/);
  assert.match(messaging.replies[5].messages[0].text, /ดีท็อกซ์หนังศีรษะ/);
  const confirmBtn = messaging.replies[5].messages[0].quickReply.items.find((i) => i.action.label === "ยืนยันการจอง");
  assert.ok(confirmBtn);

  // Turn 7: User clicks confirm button
  await sendWebhook({
    type: "postback",
    webhookEventId: `ev-${++seq}`,
    replyToken: `tok-${seq}`,
    source: { type: "user", userId: user },
    postback: { data: confirmBtn.action.data }
  });
  assert.equal(messaging.replies.length, 7);
  assert.match(messaging.replies[6].messages[0].text, /จองสำเร็จ/);
  assert.equal(f.getCreateCount(), 1);

  // Turn 8: User clicks confirm again (duplicate confirm)
  await sendWebhook({
    type: "postback",
    webhookEventId: `ev-${++seq}`,
    replyToken: `tok-${seq}`,
    source: { type: "user", userId: user },
    postback: { data: confirmBtn.action.data }
  });
  assert.equal(messaging.replies.length, 8);
  assert.match(messaging.replies[7].messages[0].text, /ได้รับการยืนยันเรียบร้อยแล้ว/);
  assert.equal(f.getCreateCount(), 1); // No double booking
});
