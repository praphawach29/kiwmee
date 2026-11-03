// The public booking API (design step 4), used by app/api/b/[slug]/*. Plain functions that take a
// database client and `now`, so they are tested against the test database without a server.
//
//   shopInfo  — what the booking page shows before any choice: name, how to start, offerings, stylists
//   step      — after each choice: keep what still works, say what is next, list its options
//   book      — create the booking through the create_booking RPC (which checks everything again)

const crypto = require("node:crypto");
const { REASON_TEXT } = require("./reason-text");
const { AppError, badRequest, notFound } = require("../errors");
const { findShopWithCatalog } = require("./catalog-repository");
const { getOptions, nextStep, reconcile, localToMs } = require("./options-engine");
const { issueToken } = require("./manage-booking");
const { getSetting } = require("./platform-settings");
const { bookingCard, manageLink, pushLine, sealLink } = require("./line-notify");
const { amenityList } = require("./amenities");
const { promptPayQr } = require("./promptpay");
const { directionsLink } = require("./directions");

const ASKABLE = ["offering", "resource", "date", "time", "duration", "party", "addons"];
const SELECTED_KEYS = ["offeringId", "resourceId", "date", "time", "durationMinutes", "partySize"];

// the shop and its catalog in one round trip to the database (each booking step needs both)
async function requireShopWithCatalog(db, slug) {
  const found = await findShopWithCatalog(db, slug);
  if (!found) throw notFound("shop not found");
  return found;
}

// Only the known keys, with the types the engine expects. null resourceId = "anyone".
function cleanSelected(input) {
  if (input !== undefined && (typeof input !== "object" || input === null || Array.isArray(input))) {
    throw badRequest("selected must be an object");
  }
  const out = {};
  for (const key of SELECTED_KEYS) {
    const value = input?.[key];
    if (value === undefined || value === "") continue;
    if (value === null) {
      if (key === "resourceId") out.resourceId = null;
      continue;
    }
    if (key === "durationMinutes" || key === "partySize") {
      if (!Number.isInteger(value)) throw badRequest(`${key} must be a whole number`);
    } else if (typeof value !== "string" || value.length > 64) {
      throw badRequest(`${key} must be text`);
    }
    out[key] = value;
  }
  // add-ons: { "<addon id>": quantity }
  const addons = input?.addons;
  if (addons !== undefined && addons !== null) {
    if (typeof addons !== "object" || Array.isArray(addons) || Object.keys(addons).length > 50) throw badRequest("addons must be an object");
    out.addons = {};
    for (const [id, quantity] of Object.entries(addons)) {
      if (!/^[0-9a-f-]{36}$/i.test(id) || !Number.isInteger(quantity) || quantity < 0 || quantity > 1000) throw badRequest("addons must map ids to whole numbers");
      if (quantity > 0) out.addons[id] = quantity;
    }
  }
  return out;
}

function priceFrom(prices, offeringId) {
  const own = prices.filter((p) => p.offering_id === offeringId);
  if (own.length === 0) return null;
  const cheapest = own.reduce((a, b) => (b.amount < a.amount ? b : a));
  return { amount: cheapest.amount, unit: cheapest.unit, varies: new Set(own.map((p) => p.amount)).size > 1 };
}

async function shopInfo(db, slug) {
  const { shop, catalog } = await requireShopWithCatalog(db, slug);
  // Keep gallery reads out of the availability snapshot: media never affects booking rules.
  const { rows: [gallery] } = await db.query(
    `select b.media, b.amenities, b.about, b.address, b.map_url,
            (select coalesce(jsonb_object_agg(o.id, o.media), '{}'::jsonb)
               from public.offerings o where o.business_id = b.id and o.active) as offering_media,
            (select coalesce(jsonb_object_agg(r.id, r.media), '{}'::jsonb)
               from public.resources r where r.business_id = b.id and r.active) as resource_media
       from public.businesses b where b.id = $1`, [shop.id]
  );
  const pickable = new Set(
    catalog.requirements
      .filter((r) => r.customer_picks)
      .flatMap((r) =>
        catalog.offeringResources
          .filter((l) => l.offering_id === r.offering_id)
          .map((l) => catalog.resources.find((res) => res.id === l.resource_id && res.kind === r.kind)?.id)
      )
      .filter(Boolean)
  );
  const bySort = (a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0) || a.name.localeCompare(b.name);
  return {
    slug: shop.slug,
    name: shop.name,
    kind: shop.kind,
    timezone: shop.timezone,
    media: gallery.media,
    amenities: amenityList(gallery.amenities).map((a) => a.code),
    about: gallery.about ?? "",
    address: gallery.address ?? "",
    directions: directionsLink({ address: gallery.address, mapUrl: gallery.map_url }),
    documentRetentionDays: catalog.settings?.document_retention_days ?? 30,
    flow: {
      entry: catalog.flow.entry,
      then: catalog.flow.then,
      showAnyStaff: Boolean(catalog.flow.options?.show_any_staff)
    },
    // what the customer may do later from the link they get after booking
    // asked before booking; the transfer details come with the held booking
    deposit: (catalog.settings?.deposit_mode ?? "none") === "none"
      ? null
      : { mode: catalog.settings.deposit_mode, value: catalog.settings.deposit_value, holdMinutes: catalog.settings.hold_minutes },
    selfService: {
      cancel: catalog.settings?.customer_can_cancel ?? true,
      reschedule: catalog.settings?.customer_can_reschedule ?? true,
      cutoffHours: catalog.settings?.customer_change_cutoff_hours ?? 2
    },
    offerings: [...catalog.offerings].sort(bySort).map((o) => ({
      id: o.id,
      name: o.name,
      category: o.category,
      description: o.description,
      media: gallery.offering_media[o.id] ?? [],
      durationMinutes: o.duration_mode === "fixed" ? o.duration_minutes : null,
      minMinutes: o.duration_mode === "customer_choice" ? o.min_minutes : null,
      maxMinutes: o.duration_mode === "customer_choice" ? o.max_minutes : null,
      // rented by the day (design 11.7)
      requiredDocuments: o.required_documents ?? [],
      minDays: o.duration_mode === "days" ? o.min_days : null,
      maxDays: o.duration_mode === "days" ? o.max_days : null,
      maxPartySize: o.max_party_size,
      price: priceFrom(catalog.prices, o.id)
    })),
    resources: catalog.resources
      .filter((r) => pickable.has(r.id))
      .sort(bySort)
      .map((r) => ({ id: r.id, name: r.name, kind: r.kind, media: gallery.resource_media[r.id] ?? [] })),
    // optional extras (design §11) for the page to show and price; which ones can be taken at the
    // chosen time comes from step() (ask "addons")
    addonGroups: [...catalog.addonGroups]
      .sort(bySort)
      .map((g) => ({
        id: g.id,
        name: g.name,
        minSelect: g.min_select,
        maxSelect: g.max_select,
        sortOrder: g.sort_order,
        offeringIds: catalog.addonLinks.filter((l) => l.group_id === g.id).map((l) => l.offering_id),
        addons: catalog.addons
          .filter((a) => a.group_id === g.id)
          .sort(bySort)
          .map((a) => ({
            id: a.id,
            name: a.name,
            description: a.description,
            media: a.media,
            priceUnit: a.price_unit,
            amount: a.amount,
            maxQuantity: a.max_quantity,
            addsMinutes: a.adds_minutes
          }))
      }))
      .filter((g) => g.addons.length > 0 && g.offeringIds.length > 0)
  };
}

/**
 * body = { selected, changed?, ask? }
 *   changed: the step the customer just chose or changed (earlier choices are re-checked)
 *   ask:     a step to show instead of the next one (the customer tapped a step to change it)
 */
async function step(db, slug, body = {}, now = new Date()) {
  const { shop, catalog } = await requireShopWithCatalog(db, slug);
  let selected = cleanSelected(body.selected);
  let cleared = [];
  if (body.changed !== undefined) {
    if (!ASKABLE.includes(body.changed)) throw badRequest("unknown step");
    ({ selected, cleared } = reconcile(catalog, { selected, changed: body.changed, now }));
  }
  const next = nextStep(catalog, { selected, now });
  let ask = null;
  if (body.ask !== undefined) {
    if (!ASKABLE.includes(body.ask)) throw badRequest("unknown step");
    ask = body.ask;
  } else if (ASKABLE.includes(next.step)) {
    ask = next.step;
  }
  // Changing the offering or the day should not be limited by the stylist chosen for the old one:
  // every offering/day stays on the list, and a stylist who no longer fits is cleared (with the
  // reason) once the customer picks.
  const narrowBy = body.ask !== undefined && (ask === "offering" || ask === "date") ? { ...selected, resourceId: undefined } : selected;
  const result = ask ? getOptions(catalog, { ask, selected: narrowBy, now }) : { options: null, reason: null };
  return { selected, cleared, next, ask, options: result.options, reason: result.reason, ...(result.groups ? { groups: result.groups } : {}) };
}

const THAI_PHONE = /^0\d{8,9}$/;

/**
 * body = { selected, customer: { name, phone }, lineIdToken? }
 * verifyLineToken(idToken) → { sub, name } | null, injected so tests need no network.
 */
async function book(
  db,
  slug,
  body = {},
  { now = new Date(), verifyLineToken = (token) => verifyLineIdToken(token, db), notifyLine = (to, messages) => pushLine(db, to, messages), origin = null } = {}
) {
  const { shop, catalog } = await requireShopWithCatalog(db, slug);
  const selected = cleanSelected(body.selected);
  const next = nextStep(catalog, { selected, now });
  if (ASKABLE.includes(next.step) || next.step === "start") {
    throw new AppError("INCOMPLETE", "กรุณาเลือกให้ครบก่อนยืนยัน", 422, { step: next.step });
  }

  const name = typeof body.customer?.name === "string" ? body.customer.name.trim().slice(0, 100) : "";
  const phone = typeof body.customer?.phone === "string" ? body.customer.phone.replace(/[\s-]/g, "") : "";
  let line = null;
  if (body.lineIdToken) {
    line = await verifyLineToken(String(body.lineIdToken));
    if (!line) throw new AppError("FORBIDDEN", "ยืนยันตัวตน LINE ไม่สำเร็จ กรุณาเปิดจาก LINE อีกครั้ง", 403);
  }
  if (!name) throw new AppError("INVALID_CUSTOMER", "กรุณากรอกชื่อ", 422);
  if (phone ? !THAI_PHONE.test(phone) : !line) {
    throw new AppError("INVALID_CUSTOMER", "กรุณากรอกเบอร์โทร 10 หลัก", 422);
  }

  const startAt = new Date(localToMs(selected.date, selected.time, shop.timezone)).toISOString();
  // a deposit to transfer (or a flow that ends in payment): the booking is held until the shop has it
  const hold = (catalog.flow.then || []).includes("payment") || (catalog.settings?.deposit_mode ?? "none") !== "none";
  // the customer's link to see, cancel or move this booking (/b/<slug>/manage/<token>)
  const link = issueToken();
  let result;
  try {
    const { rows } = await db.query(
      "select public.booking_attach_manage_token(public.create_booking($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9, null, $11::jsonb), $10) as booking",
      [
        shop.id,
        selected.offeringId,
        startAt,
        JSON.stringify({ name, phone: phone || null, line_user_id: line?.sub ?? null }),
        selected.resourceId ?? null,
        selected.durationMinutes ?? null,
        selected.partySize ?? 1,
        hold,
        line ? "liff" : "web",
        link.hash,
        JSON.stringify(selected.addons ?? {})
      ]
    );
    const b = rows[0].booking;
    const ids = b.resources.filter((r) => !r.addon_id).map((r) => r.resource_id); // a rented racket is not "the stylist"
    const names = (await db.query("select id, name from public.resources where business_id = $1 and id = any($2::uuid[])", [shop.id, ids])).rows;
    result = {
      id: b.id,
      status: b.status,
      startAt: b.start_at,
      endAt: b.end_at,
      holdExpiresAt: b.hold_expires_at,
      deposit: b.deposit_due !== null && b.deposit_due !== undefined
        ? { due: Number(b.deposit_due), paymentInfo: catalog.settings?.payment_info ?? {} }
        : null,
      price: b.price,
      manageToken: link.token,
      addons: (b.addons ?? []).map((a) => ({ id: a.addon_id, name: a.name, quantity: a.quantity, total: Number(a.total) })),
      resources: ids.map((id) => ({ id, name: names.find((n) => n.id === id)?.name ?? null, kind: catalog.resources.find((r) => r.id === id)?.kind ?? null }))
    };
  } catch (error) {
    throw bookingError(error);
  }
  // a PromptPay QR with the deposit already filled in, when the shop takes PromptPay
  if (result.deposit && result.status === "held") {
    const qr = await promptPayQr(result.deposit.paymentInfo?.promptPay, result.deposit.due).catch(() => null);
    if (qr) result.deposit.qr = qr;
  }

  // Booked inside LINE: the card goes to the customer's chat with Kiwmee's OA (never fails the booking)
  if (line) {
    try {
      // kept (encrypted) so the reminders can carry the same link
      const sealed = sealLink(result.id, result.manageToken);
      if (sealed) await db.query("update public.bookings set line_manage_token = $2 where id = $1", [result.id, sealed]);
    } catch (error) {
      console.error("[line-notify] link not kept:", error.message);
    }
    try {
      const card = bookingCard({
        kind: result.status === "held" ? "held" : "booked",
        shop: { name: shop.name, timezone: shop.timezone },
        booking: {
          offering: catalog.offerings.find((o) => o.id === selected.offeringId)?.name ?? "นัดหมาย",
          startAt: result.startAt,
          endAt: result.endAt,
          resources: result.resources.map((r) => r.name).filter(Boolean),
          resourceKind: catalog.resources.find((r) => r.id === result.resources[0]?.id)?.kind ?? null,
          addons: result.addons,
          total: Number(result.price?.total ?? 0),
          deposit: result.deposit ? { due: result.deposit.due, holdExpiresAt: result.holdExpiresAt } : null
        },
        link: await manageLink(db, { slug: shop.slug, token: result.manageToken, origin }),
        directions: directionsLink({ address: shop.address, mapUrl: shop.map_url })
      });
      result.line = await notifyLine(line.sub, [card]);
    } catch (error) {
      console.error("[line-notify] card not sent:", error.message);
      result.line = { sent: false, reason: "ERROR" };
    }
  }
  return result;
}

// create_booking reports why in the message, with BK409 / BK422 / BK404 as the code
function bookingError(error) {
  const kind = { BK409: ["CONFLICT", 409], BK422: ["UNAVAILABLE", 422], BK404: ["NOT_FOUND", 404] }[error?.code];
  if (!kind) return error;
  return new AppError(kind[0], REASON_TEXT[error.message] ?? error.message, kind[1], { reason: error.message });
}

// LIFF: the page sends the LINE ID token; LINE confirms it and tells us who it is
async function verifyLineIdToken(idToken, db) {
  const clientId = await getSetting(db, "line.login_channel_id"); // saved from /super, else LINE_LOGIN_CHANNEL_ID
  if (!clientId) return null;
  const response = await fetch("https://api.line.me/oauth2/v2.1/verify", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ id_token: idToken, client_id: clientId }),
    signal: AbortSignal.timeout(5000)
  });
  if (!response.ok) return null;
  const claims = await response.json();
  return claims?.sub ? { sub: claims.sub, name: claims.name ?? null } : null;
}

// The client's address as the hosting platform reports it (Vercel sets x-forwarded-for)
function clientKey(request) {
  return request.headers.get("x-forwarded-for")?.split(",")[0].trim() || request.headers.get("x-real-ip") || "unknown";
}

// Per-client limits kept in the database (serverless instances share no memory)
async function rateLimit(db, clientKey, bucket, max, windowSeconds) {
  const keyHash = crypto.createHash("sha256").update(`${bucket}:${clientKey}`).digest("hex");
  const { rows } = await db.query("select public.hit_rate_limit($1, $2, $3) as ok", [keyHash, max, windowSeconds]);
  if (!rows[0].ok) throw new AppError("RATE_LIMITED", "ส่งคำขอถี่เกินไป กรุณารอสักครู่", 429);
}

module.exports = { shopInfo, step, book, rateLimit, clientKey, cleanSelected, verifyLineIdToken, bookingError };
