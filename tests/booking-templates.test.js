const test = require("node:test");
const assert = require("node:assert/strict");
const templates = require("../src/v2/booking-templates");
const { checkFlow } = require("../src/v2/admin-catalog");

function catalog() {
  return {
    shop: { role: "owner" },
    settings: { maxAdvanceDays: 21 },
    flow: { entry: ["date"], require: ["offering", "date", "time"], optional: [], then: ["customer"], options: { showAnyStaff: false, dateRangeDays: 11 } },
    resources: [{ id: "staff", kind: "staff", capacity: 1, active: true }],
    offerings: [{ id: "cut", name: "Cut", active: true, durationMode: "fixed", durationMinutes: 30, maxPartySize: 1,
      requirements: [{ kind: "staff", customerPicks: true, unitsPerBooking: "one" }], resourceIds: ["staff"], prices: [] }]
  };
}

test("catalog is deeply immutable and honestly separates existing engine from planned templates", () => {
  assert.deepEqual(templates.BOOKING_TEMPLATES.map((t) => t.id), ["appointment", "resource_slot", "capacity_session", "rental_range", "service_visit"]);
  for (const item of templates.BOOKING_TEMPLATES) {
    assert.ok(Object.isFrozen(item));
    assert.ok(Object.isFrozen(item.capabilities));
    assert.ok(item.description);
    if (item.status === "planned") assert.ok(item.reason);
  }
  assert.ok(Object.isFrozen(templates.BOOKING_TEMPLATES));
  const c = catalog();
  const before = structuredClone(c);
  const preview = templates.previewBookingTemplate("appointment", c);
  assert.equal(preview.applicable, true);
  assert.equal(preview.flow.options.dateRangeDays, 11);
  assert.deepEqual(preview.flow.optional, ["resource"]);
  assert.deepEqual(checkFlow(preview.flow).then, ["customer"]);
  assert.deepEqual(c, before);
});

test("planned, unknown and missing capabilities never produce an applicable flow", () => {
  for (const id of ["rental_range", "service_visit", "unknown"]) {
    const result = templates.previewBookingTemplate(id, catalog());
    assert.equal(result.applicable, false);
    assert.equal(result.flow, null);
    assert.ok(result.errors[0].message);
  }
  for (const id of ["appointment", "resource_slot", "capacity_session"]) {
    const result = templates.previewBookingTemplate(id, { offerings: [], resources: [] });
    assert.equal(result.applicable, false);
    assert.ok(result.errors.some((e) => e.code === "NO_ACTIVE_OFFERINGS"));
  }
  const c = catalog();
  c.resources[0].active = false;
  assert.ok(templates.previewBookingTemplate("appointment", c).errors.some((e) => e.code === "MISSING_LINKED_RESOURCE"));
  assert.equal(templates.previewBookingTemplate("resource_slot", catalog()).applicable, false);
  assert.equal(templates.previewBookingTemplate("capacity_session", catalog()).applicable, false);
});

test("resource slot mapping is validator-valid and retains mixed catalog inputs", () => {
  const c = catalog();
  c.resources.push({ id: "court", kind: "court", capacity: 1, active: true });
  c.offerings.push({ id: "court-time", name: "Court", active: true, durationMode: "customer_choice", minMinutes: 60, maxMinutes: 180, stepMinutes: 60, maxPartySize: 2,
    requirements: [{ kind: "court", customerPicks: true, unitsPerBooking: "one" }], resourceIds: ["court"] });
  const mixed = templates.previewBookingTemplate("resource_slot", c);
  assert.equal(mixed.applicable, true);
  assert.deepEqual(mixed.flow.entry, ["offering"], "do not hide other offerings behind a resource-first entry");
  assert.ok(mixed.flow.require.includes("duration"));
  assert.ok(mixed.flow.require.includes("party"));
  assert.doesNotThrow(() => checkFlow(mixed.flow));
  c.offerings.shift();
  const resourceOnly = templates.previewBookingTemplate("resource_slot", c);
  assert.deepEqual(resourceOnly.flow.entry, ["resource"]);
  assert.doesNotThrow(() => checkFlow(resourceOnly.flow));
});

test("capacity means party-size units on linked capacity, not merely maxPartySize", () => {
  const c = catalog();
  c.offerings[0].maxPartySize = 5;
  c.resources[0].capacity = 10;
  assert.equal(templates.previewBookingTemplate("capacity_session", c).applicable, false);
  c.offerings[0].requirements[0].unitsPerBooking = "party_size";
  const result = templates.previewBookingTemplate("capacity_session", c);
  assert.equal(result.applicable, true);
  assert.ok(result.flow.require.includes("party"));
  assert.doesNotThrow(() => checkFlow(result.flow));
  c.resources[0].capacity = 4;
  assert.equal(templates.previewBookingTemplate("capacity_session", c).applicable, false);
});

test("draft round trip preserves custom flow verbatim until explicit edits", async () => {
  const { bookingFlowDraft, bookingFlowFromDraft } = await import("../app/dashboard/[slug]/flow-preview.mjs");
  const c = catalog();
  c.flow.require = ["date", "time", "offering"];
  c.flow.options.extra = "preserve";
  const before = structuredClone(c.flow);
  const draft = bookingFlowDraft(c.flow);
  assert.deepEqual(bookingFlowFromDraft(draft), before);
  templates.previewBookingTemplate("appointment", c, bookingFlowFromDraft(draft));
  assert.deepEqual(bookingFlowFromDraft(draft), before, "preview must not select or mutate the current flow");
  const chosen = templates.previewBookingTemplate("appointment", c).flow;
  assert.deepEqual(bookingFlowFromDraft(bookingFlowDraft(chosen)), chosen);
  draft.modes.party = "require";
  assert.ok(bookingFlowFromDraft(draft).require.includes("party"));
  assert.equal(bookingFlowFromDraft(draft).options.extra, "preserve");
});

test("mapped capacity flow actually enforces party-size capacity in the existing engine", () => {
  const { getOptions } = require("../src/v2/options-engine");
  const c = catalog();
  c.offerings[0].maxPartySize = 5;
  c.offerings[0].requirements[0].unitsPerBooking = "party_size";
  c.resources[0].capacity = 5;
  const preview = templates.previewBookingTemplate("capacity_session", c);
  const engine = {
    business: { timezone: "Asia/Bangkok" }, flow: checkFlow(preview.flow),
    settings: { min_lead_minutes: 0, max_advance_days: 30, slot_interval_minutes: 30 },
    offerings: [{ id: "cut", name: "Cut", duration_mode: "fixed", duration_minutes: 30, max_party_size: 5 }],
    resources: c.resources,
    requirements: [{ offering_id: "cut", kind: "staff", customer_picks: true, units_per_booking: "party_size" }],
    offeringResources: [{ offering_id: "cut", resource_id: "staff" }],
    busy: [{ resource_id: "staff", units: 3, start_at: "2026-11-01T10:00:00+07:00", end_at: "2026-11-01T10:30:00+07:00" }]
  };
  const result = getOptions(engine, { ask: "party", selected: { offeringId: "cut", resourceId: "staff", date: "2026-11-01", time: "10:00" }, now: "2026-10-31T00:00:00+07:00" });
  assert.equal(result.options.find((o) => o.value === 2).available, true);
  assert.equal(result.options.find((o) => o.value === 3).available, false);
});

test("FlowTab renders an owner-only honest selector with save disabled for the untouched flow", async () => {
  const fs = require("node:fs");
  const { transformSync } = require("next/dist/build/swc");
  const React = require("react");
  const { renderToStaticMarkup } = require("react-dom/server");
  const helpers = await import("../app/dashboard/[slug]/flow-preview.mjs");
  const source = fs.readFileSync(require("node:path").join(__dirname, "../app/dashboard/[slug]/shop-admin-client.jsx"), "utf8");
  const functionSource = source.slice(source.indexOf("function FlowTab("), source.indexOf("// ---------- offerings and prices"));
  const compiled = transformSync(functionSource, { jsc: { parser: { syntax: "ecmascript", jsx: true }, transform: { react: { runtime: "classic" } } }, module: { type: "commonjs" } }).code;
  const bindings = { React, ...React, ...helpers, ...templates, useSave: () => ({}), Locked: ({ children }) => children, Status: () => null };
  const FlowTab = new Function(...Object.keys(bindings), compiled + "; return FlowTab;")(...Object.values(bindings));
  const c = catalog();
  const html = renderToStaticMarkup(React.createElement(FlowTab, { slug: "shop", catalog: c, onSaved() {} }));
  assert.match(html, /booking-template/);
  assert.match(html, /rental_range/);
  assert.match(html, /อยู่ในแผน/);
  assert.match(html, /disabled=""[^>]*>บันทึกขั้นตอนจอง/);
  c.shop.role = "staff";
  assert.equal(renderToStaticMarkup(React.createElement(FlowTab, { slug: "shop", catalog: c })), "");
  const { resolveShopTab } = await import("../app/dashboard/merchant-navigation.mjs");
  assert.notEqual(resolveShopTab("staff", "flow"), "flow");
  assert.equal(resolveShopTab("owner", "flow"), "flow");

  // Exercise actual FlowTab handlers without a server: selection is preview-only,
  // staging is local, and only the existing explicit Save invokes the API.
  const states = [];
  let cursor = 0;
  const writes = [];
  // api/shopPath are lexical globals used only by Save; inject them into the compiled scope.
  const interactiveBindings = { ...bindings,
    useMemo: (fn) => fn(), useEffect: () => {},
    useState: (initial) => {
      const index = cursor++;
      if (!(index in states)) states[index] = initial;
      return [states[index], (value) => { states[index] = typeof value === "function" ? value(states[index]) : value; }];
    },
    useSave: () => ({ run: async (fn) => { await fn(); return true; } }),
    api: async (...args) => { writes.push(args); },
    shopPath: (slug, suffix) => `/api/dashboard/shops/${slug}${suffix}`
  };
  const Editor = new Function(...Object.keys(interactiveBindings), compiled + "; return FlowTab;")(...Object.values(interactiveBindings));
  c.shop.role = "owner";
  const original = structuredClone(c);
  const render = () => { cursor = 0; return Editor({ slug: "shop", catalog: c, onSaved() {} }); };
  const nodes = (node) => !node || typeof node !== "object" ? [] : Array.isArray(node) ? node.flatMap(nodes) : [node, ...nodes(node.props?.children)];
  let tree = render();
  nodes(tree).find((n) => n.props?.id === "booking-template").props.onChange({ target: { value: "appointment" } });
  tree = render();
  assert.deepEqual(writes, []);
  assert.equal(nodes(tree).find((n) => n.props?.children === "บันทึกขั้นตอนจอง").props.disabled, true);
  nodes(tree).find((n) => n.props?.children === "ใช้แบบนี้กับแบบร่าง (ยังไม่บันทึก)").props.onClick();
  tree = render();
  assert.deepEqual(writes, []);
  assert.deepEqual(c, original);
  const saveButton = nodes(tree).find((n) => n.props?.children === "บันทึกขั้นตอนจอง");
  assert.equal(saveButton.props.disabled, false);
  await saveButton.props.onClick();
  assert.equal(writes.length, 1);
  assert.equal(writes[0][0], "PUT");
  assert.equal(writes[0][1], "/api/dashboard/shops/shop/flow");
  assert.doesNotThrow(() => checkFlow(writes[0][2]));
  nodes(tree).find((n) => n.props?.id === "booking-template").props.onChange({ target: { value: "rental_range" } });
  tree = render();
  const unavailable = nodes(tree).find((n) => n.props?.children === "ใช้แบบนี้กับแบบร่าง (ยังไม่บันทึก)");
  assert.equal(unavailable.props.disabled, true);
  const previousDraft = structuredClone(states[0]);
  unavailable.props.onClick();
  assert.deepEqual(states[0], previousDraft);
  assert.equal(writes.length, 1);
});

test("invalid duration and multiple customer-picked kinds cannot masquerade as supported", () => {
  const c = catalog();
  c.offerings[0].durationMinutes = 0;
  assert.ok(templates.previewBookingTemplate("appointment", c).errors.some((e) => e.code === "INVALID_DURATION"));
  c.offerings[0].durationMinutes = 30;
  c.resources.push({ id: "room", kind: "room", active: true, capacity: 1 });
  c.offerings[0].resourceIds.push("room");
  c.offerings[0].requirements.push({ kind: "room", customerPicks: true, unitsPerBooking: "one" });
  assert.ok(templates.previewBookingTemplate("appointment", c).errors.some((e) => e.code === "MULTIPLE_PICKED_KINDS"));
});
