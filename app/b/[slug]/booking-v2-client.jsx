"use client";

// The v2 booking page (design §5): the customer starts from a date or an offering (as the shop's
// flow allows), every step lists only what can really be booked (the rest greyed out with a
// reason), and tapping an earlier step lets them change it without starting over.
// The server decides what comes next (POST /api/b/{slug}/step); this page only shows it.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import CustomerFrame from "./customer-frame.jsx";
import { BookingProgress, BookingReview, BookingSubmitBar, DepositBox, OfferingDetails, ShopHeader, ShopGallery, OfferingThumbnail, ResourceChoice, groupTimes } from "./booking-presentation.jsx";

const RESOURCE_WORD = { staff: "ช่าง", court: "สนาม", room: "ห้อง", equipment: "อุปกรณ์" };
const STEP_TITLE = {
  offering: "เลือกบริการ",
  date: "เลือกวัน",
  time: "เลือกเวลา",
  duration: "ใช้เวลานานเท่าไหร่",
  party: "จำนวนคน",
  addons: "ตัวเลือกเพิ่มเติม"
};
const REASON_TEXT = {
  FULLY_BOOKED: "เต็ม",
  BUSINESS_CLOSED: "ร้านปิด",
  STAFF_OFF: "ไม่อยู่",
  NO_WORKING_WINDOW: "ไม่มีคิว",
  NO_AVAILABLE_SLOTS: "ไม่มีคิว",
  PAST_WORKING_HOURS: "หมดเวลาจอง",
  OUTSIDE_BOOKING_WINDOW: "ยังไม่เปิดจอง",
  NOT_OFFERED: "ไม่มีบริการนี้",
  RESOURCE_BUSY: "หมดในเวลานี้",
  NOT_ENOUGH_TIME: "เวลาไม่พอ",
  ADDON_GROUP_RULE: "เลือกเกินจำนวน"
};
// a day's tile is narrow: one short word under the date
const DAY_REASON_TEXT = { ...REASON_TEXT, PAST_WORKING_HOURS: "ปิดแล้ว", OUTSIDE_BOOKING_WINDOW: "ยังไม่เปิด" };
const KEY = {
  offering: "offeringId",
  resource: "resourceId",
  date: "date",
  time: "time",
  duration: "durationMinutes",
  party: "partySize",
  addons: "addons"
};
const SUMMARY_ORDER = ["date", "offering", "resource", "time", "duration", "party", "addons"];
// labels in the summary (short, so the value keeps the room)
const SUMMARY_LABEL = { date: "วัน", offering: "บริการ", time: "เวลา", duration: "ระยะเวลา", party: "จำนวน", addons: "เพิ่มเติม" };
const ADDON_UNIT = { per_unit: "/ชิ้น", per_hour: "/ชม.", per_day: "/วัน", per_person: "/คน", per_booking: "" };

function formatDate(date, { long = false, shortMonth = false } = {}) {
  return new Intl.DateTimeFormat("th-TH", {
    timeZone: "UTC",
    weekday: long ? "long" : "short",
    day: "numeric",
    month: long && !shortMonth ? "long" : "short",
    year: "numeric"
  }).format(new Date(`${date}T00:00:00Z`));
}

function formatMinutes(minutes) {
  if (minutes < 60) return `${minutes} นาที`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h} ชม. ${m} นาที` : `${h} ชม.`;
}

const money = (amount) => `${Number(amount).toLocaleString("th-TH")} บาท`;

function priceText(price) {
  if (!price) return "";
  const per = price.unit === "per_hour" ? "/ชม." : price.unit === "per_person" ? "/คน" : "";
  return `${price.varies ? "เริ่ม " : ""}${money(price.amount)}${per}`;
}

// What the customer will pay, as far as the page can tell before the server prices the booking.
// A price that changes by day or time ("varies") is only ever shown as a starting price.
// What the chosen add-ons add, as create_booking prices them (booking_plan): per_hour on the whole
// booking's minutes, per_day on its days (a booking within one day = 1)
function addonTotal(addons, selected, minutes) {
  let total = 0;
  for (const [id, quantity] of Object.entries(selected.addons ?? {})) {
    const a = addons.get(id);
    if (!a || !quantity) continue;
    const amount = Number(a.amount);
    if (a.priceUnit === "per_hour") total += (amount * (minutes ?? 0) * quantity) / 60;
    else if (a.priceUnit === "per_day") total += amount * Math.max(Math.ceil((minutes ?? 0) / 1440), 1) * quantity;
    else if (a.priceUnit === "per_person") total += amount * (selected.partySize ?? 1);
    else total += amount * quantity;
  }
  return Math.round(total * 100) / 100;
}

function priceEstimate(offering, selected, addons = new Map()) {
  const base = offeringEstimate(offering, selected);
  if (!base) return null;
  const extraMinutes = Object.entries(selected.addons ?? {}).reduce((sum, [id, q]) => sum + (addons.get(id)?.addsMinutes ?? 0) * q, 0);
  const minutes = (selected.durationMinutes ?? offering.durationMinutes ?? 0) + extraMinutes;
  const more = addonTotal(addons, selected, minutes);
  if (!more) return base;
  if (base.amount === null) return { label: base.label, value: `${base.value} + ${money(more)}`, short: null };
  const total = base.amount + more;
  return base.short ? { label: base.label, value: money(total), short: money(total), amount: total } : { label: base.label, value: `เริ่ม ${money(total)}`, short: null, amount: total };
}

function offeringEstimate(offering, selected) {
  const price = offering?.price;
  if (!price) return null;
  let amount = Number(price.amount);
  const minutes = selected.durationMinutes ?? offering.durationMinutes;
  if (price.unit === "per_hour") {
    if (!minutes) return { label: "ราคา", value: priceText(price), short: null, amount: null };
    amount = (amount * minutes) / 60;
  }
  if (price.unit === "per_person") {
    if (!selected.partySize) return { label: "ราคา", value: priceText(price), short: null, amount: null };
    amount *= selected.partySize;
  }
  if (price.varies) return { label: "ราคาเริ่มต้น", value: `เริ่ม ${money(amount)}`, short: null, amount };
  return { label: "ราคา", value: money(amount), short: money(amount), amount };
}

// YYYY-MM-DD for "now" in the shop's own time zone
function todayIn(timezone) {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  } catch {
    return null;
  }
}

async function post(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload?.error?.message || "ระบบขัดข้อง กรุณาลองใหม่");
    error.status = response.status;
    error.code = payload?.error?.code;
    error.reason = payload?.error?.details?.reason;
    throw error;
  }
  return payload.data;
}

function useLiff(liffId) {
  const [liff, setLiff] = useState({ ready: !liffId, idToken: null, name: "" });
  useEffect(() => {
    if (!liffId) return;
    let cancelled = false;
    const script = document.createElement("script");
    script.src = "https://static.line-scdn.net/liff/edge/2/sdk.js";
    script.onload = async () => {
      try {
        await window.liff.init({ liffId });
        if (!window.liff.isInClient() && !window.liff.isLoggedIn()) {
          if (!cancelled) setLiff({ ready: true, idToken: null, name: "" });
          return;
        }
        if (!window.liff.isLoggedIn()) {
          window.liff.login();
          return;
        }
        const profile = await window.liff.getProfile().catch(() => null);
        if (!cancelled) setLiff({ ready: true, idToken: window.liff.getIDToken(), name: profile?.displayName ?? "" });
      } catch {
        if (!cancelled) setLiff({ ready: true, idToken: null, name: "" });
      }
    };
    script.onerror = () => !cancelled && setLiff({ ready: true, idToken: null, name: "" });
    document.head.appendChild(script);
    return () => {
      cancelled = true;
    };
  }, [liffId]);
  return liff;
}

export default function BookingV2Client({ shop, liffId, initialView = null }) {
  const api = `/api/b/${shop.slug}`;
  const [selected, setSelected] = useState(() => initialView?.selected ?? {});
  const [view, setView] = useState(initialView); // { next, ask, options, reason }
  const [pending, setPending] = useState(null); // { step, value } tapped, waiting for the server
  const [details, setDetails] = useState(null); // the offering option whose details are open
  const [notice, setNotice] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(!initialView);
  const [customer, setCustomer] = useState({ name: "", phone: "" });
  const [booking, setBooking] = useState(null);
  const liff = useLiff(liffId);

  const offerings = useMemo(() => new Map(shop.offerings.map((o) => [o.id, o])), [shop.offerings]);
  const resources = useMemo(() => new Map(shop.resources.map((r) => [r.id, r])), [shop.resources]);
  const addonInfo = useMemo(() => new Map((shop.addonGroups ?? []).flatMap((g) => g.addons.map((a) => [a.id, a]))), [shop.addonGroups]);
  // a kind the shop named itself ("เก้าอี้นวด") is its own word
  const kind = shop.resources[0]?.kind;
  const resourceWord = RESOURCE_WORD[kind] ?? kind ?? "ช่าง";

  useEffect(() => {
    if (liff.name) setCustomer((c) => (c.name ? c : { ...c, name: liff.name }));
  }, [liff.name]);

  const valueLabel = useCallback(
    (step, value) => {
      if (step === "offering") return offerings.get(value)?.name ?? "บริการ";
      if (step === "resource") return value === null ? `${resourceWord}คนไหนก็ได้` : resources.get(value)?.name ?? resourceWord;
      if (step === "date") return formatDate(value, { long: true });
      if (step === "time") return `${value} น.`;
      if (step === "duration") return formatMinutes(value);
      if (step === "party") return `${value} คน`;
      if (step === "addons") {
        // a single add-on id (a cleared one), or the picks { id: quantity }
        if (typeof value === "string") return addonInfo.get(value)?.name ?? "ตัวเลือกเสริม";
        const picked = Object.entries(value ?? {}).filter(([, q]) => q > 0);
        return picked.length ? picked.map(([id, q]) => `${addonInfo.get(id)?.name ?? "ตัวเลือก"}${q > 1 ? ` ×${q}` : ""}`).join(", ") : "ไม่เพิ่ม";
      }
      return String(value);
    },
    [offerings, resources, resourceWord, addonInfo]
  );

  const run = useCallback(
    async (body) => {
      setBusy(true);
      setError(null);
      try {
        const data = await post(`${api}/step`, body);
        setSelected(data.selected);
        setView(data);
        const dropped = data.cleared.filter((c) => c.reason);
        setNotice(
          dropped.length
            ? dropped
                .map((c) => `${valueLabel(c.step, c.value)} ${REASON_TEXT[c.reason] ?? "ใช้ไม่ได้แล้ว"} — กรุณาเลือกใหม่`)
                .join(" · ")
            : null
        );
      } catch (e) {
        setError(e.message);
      } finally {
        setBusy(false);
        setPending(null);
      }
    },
    [api, valueLabel]
  );

  // the server sends the first step with the page; fetch it only if that did not work
  useEffect(() => {
    if (!initialView) run({ selected: {} });
  }, [run, initialView]);

  const [category, setCategory] = useState(null);
  const summaryItems = SUMMARY_ORDER.filter((s) => selected[KEY[s]] !== undefined).map((s) => ({
    step: s,
    label: s === "resource" ? resourceWord : SUMMARY_LABEL[s] ?? s,
    value: s === "date" ? mediumDate(selected.date) : valueLabel(s, selected[KEY[s]]),
    // the day on its own line, the date below it
    display: s === "date" ? <>{dayName(selected.date)}<br />{dateOnly(selected.date)}</> : null
  }));
  const estimate = priceEstimate(offerings.get(selected.offeringId), selected, addonInfo);

  // the tapped choice lights up at once; the server's answer follows
  const choose = (step, value) => {
    setPending({ step, value });
    return run({ selected: { ...selected, [KEY[step]]: value }, changed: step });
  };
  const showStep = (step) => {
    setPending({ step: "show", value: step });
    return run({ selected, ask: step });
  };

  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await post(`${api}/bookings`, { selected, customer, lineIdToken: liff.idToken || undefined });
      setBooking(result);
    } catch (e) {
      if (e.status === 409 && e.reason === "ADDON_UNAVAILABLE") {
        setBusy(false);
        await run({ selected, ask: "addons" });
        setNotice("ตัวเลือกเสริมที่เลือกเพิ่งหมดไป กรุณาเลือกใหม่");
        return;
      }
      if (e.status === 409) {
        setBusy(false);
        await run({ selected: { ...selected, time: undefined }, ask: "time" });
        setNotice("ช่วงเวลานี้เพิ่งถูกจองไป กรุณาเลือกเวลาใหม่");
        return;
      }
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }


  if (booking) {
    return (
      <CustomerFrame>
        <main className="bk-shell">
          <BookingDone shop={shop} booking={booking} items={summaryItems} selected={selected} resourceWord={resourceWord}
            onSlip={(view) => setBooking((b) => ({ ...b, status: view.booking.status, deposit: { ...b.deposit, slips: view.booking.deposit?.slips ?? 1 } }))} />
          <PoweredBy />
        </main>
      </CustomerFrame>
    );
  }

  const next = view?.next;
  const ask = view?.ask;
  const atStart = next?.step === "start" && !ask;
  const atCustomer = next && !ask && !atStart;
  const categories = ask === "offering" ? [...new Set((view?.options ?? []).map((o) => offerings.get(o.value)?.category).filter(Boolean))] : [];
  const shownOptions = (view?.options ?? []).filter((o) => ask !== "offering" || !category || categories.length < 2 || offerings.get(o.value)?.category === category);
  const optionProps = (o) => {
    const tapped = pending?.step === ask && pending.value === o.value;
    const chosen = pending?.step === ask ? tapped : selected[KEY[ask]] === o.value;
    return {
      type: "button",
      className: "bk-option",
      "data-testid": `option-${ask}`,
      "data-value": o.value === null ? "any" : String(o.value),
      "data-selected": chosen,
      "data-pending": tapped || undefined,
      "data-unavailable": !o.available || undefined,
      "aria-pressed": chosen,
      disabled: busy || !o.available,
      onClick: () => choose(ask, o.value)
    };
  };
  const optionButton = (o) => {
    const button = (
      <button key={String(o.value)} {...optionProps(o)}>
        <OptionBody ask={ask} option={o} offering={offerings.get(o.value)} resource={resources.get(o.value)} resourceWord={resourceWord} />
        {!o.available && <small className="bk-reason">{REASON_TEXT[o.reason] ?? "ไม่ว่าง"}</small>}
      </button>
    );
    // a service with a description or photos: the card stays short, the rest opens in a sheet
    const offering = ask === "offering" ? offerings.get(o.value) : null;
    if (!offering || (!offering.description && !(offering.media?.length > 0))) return button;
    return (
      <div key={String(o.value)} className="bk-option-wrap">
        {button}
        <button type="button" className="bk-details-link" onClick={() => setDetails(o)} aria-label={`รายละเอียด ${offering.name}`} title="รายละเอียด">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9.5" /><path d="M12 11v6" /><circle cx="12" cy="7.5" r=".6" fill="currentColor" /></svg>
        </button>
      </div>
    );
  };

  return (
    <CustomerFrame aside={<SummaryAside items={summaryItems} estimate={estimate} shop={shop} onEdit={showStep} busy={busy} />}>
      <main className="bk-shell" aria-busy={busy}>
        <ShopHeader shop={shop} subtitle="จองคิวออนไลน์ · เลือกจากคิวว่างของร้าน" />
        {/* the photos help choosing; once the customer is filling in their details they only push the form down */}
        {!atCustomer && <ShopGallery shop={shop} />}
        <BookingProgress phase={atCustomer ? "customer" : "selection"} />

        {!atCustomer && summaryItems.length > 0 && (
          <nav className="bk-chips" aria-label="ที่เลือกไว้">
            {summaryItems.map((item) => (
              <button key={item.step} type="button" className="bk-chip" data-active={ask === item.step} data-pending={(pending?.step === "show" && pending.value === item.step) || undefined} onClick={() => showStep(item.step)} disabled={busy}>
                <span>{item.step === "date" ? shortDate(selected.date) : item.value}</span>
                <small>เปลี่ยน</small>
              </button>
            ))}
          </nav>
        )}

        {notice && (
          <p className="bk-notice" role="status">
            {notice}
          </p>
        )}
        {error && (
          <p className="bk-error" role="alert">
            {error}
          </p>
        )}

        {atStart && (
          <section className="bk-card">
            <h2>เริ่มจองจาก</h2>
            <div className="bk-start">
              {next.choices.map((c) => (
                <button key={c} type="button" className="bk-start-button" data-pending={(pending?.step === "show" && pending.value === c) || undefined} onClick={() => showStep(c)} disabled={busy}>
                  <span className="bk-start-icon" aria-hidden="true">{c === "date" ? "▦" : c === "offering" ? "✂" : "☺"}</span>
                  <span className="bk-start-text">
                    <strong>{c === "date" ? "เลือกวันก่อน" : c === "offering" ? "เลือกบริการก่อน" : `เลือก${resourceWord}ก่อน`}</strong>
                    <span>
                      {c === "date" ? "ดูว่าวันไหนว่าง แล้วเลือกบริการ" : c === "offering" ? "เลือกบริการ แล้วดูวันเวลาที่ว่าง" : `เลือก${resourceWord}ที่ต้องการ`}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          </section>
        )}

        {ask && view.options && (
          <section className="bk-card" data-step={ask}>
            <div className="bk-step-head">
              <h2>{ask === "resource" ? `เลือก${resourceWord}` : STEP_TITLE[ask]}</h2>
              {ask === "time" && selected.date && <p className="bk-muted">{formatDate(selected.date, { long: true })} · เวลาตามร้าน</p>}
            </div>
            {ask !== "addons" && (view.options.length === 0 || !view.options.some((o) => o.available)) ? (
              <p className="bk-empty">{ask === "time" ? "วันนี้ไม่มีเวลาว่างแล้ว" : "ไม่มีตัวเลือกที่ว่าง"} {view.reason ? `(${REASON_TEXT[view.reason] ?? view.reason})` : ""} — ลองเปลี่ยนตัวเลือกด้านบน</p>
            ) : null}
            {categories.length > 1 && (
              <div className="bk-filter" role="group" aria-label="หมวดบริการ">
                {[null, ...categories].map((c) => (
                  <button key={c ?? "all"} type="button" aria-pressed={category === c} onClick={() => setCategory(c)}>
                    {c ?? "ทั้งหมด"}
                  </button>
                ))}
              </div>
            )}
            {ask === "addons" ? (
              <AddonsStep key={`${selected.date}-${selected.time}`} view={view} info={addonInfo} initial={selected.addons} busy={busy} onDone={(picks) => choose("addons", picks)} />
            ) : ask === "date" ? (
              <DateStrip options={view.options} today={todayIn(shop.timezone)} optionProps={optionProps} />
            ) : ask === "time" ? (
              <div className="bk-time-groups">
                {groupTimes(view.options).map((part) => (
                  <div key={part.key} className="bk-time-group">
                    <h3>
                      {part.label} <span>· ว่าง {part.options.filter((o) => o.available).length} เวลา</span>
                    </h3>
                    <div className="bk-options bk-options-time">{part.options.map(optionButton)}</div>
                  </div>
                ))}
              </div>
            ) : (
              <div className={`bk-options bk-options-${ask}`}>{shownOptions.map(optionButton)}</div>
            )}
          </section>
        )}

        {atCustomer && (
          <>
            <BookingReview items={summaryItems} onEdit={showStep} busy={busy} price={estimate} />
            <form id="booking-customer" className="bk-card" onSubmit={submit}>
              <h2>ข้อมูลผู้จอง</h2>
              <label className="bk-field">
                <span>ชื่อ</span>
                <input name="name" required maxLength={100} autoComplete="name" value={customer.name} onChange={(e) => setCustomer({ ...customer, name: e.target.value })} />
              </label>
              <label className="bk-field">
                <span>เบอร์โทร{liff.idToken ? " (ไม่บังคับ)" : ""}</span>
                <input
                  name="phone"
                  inputMode="tel"
                  autoComplete="tel"
                  required={!liff.idToken}
                  pattern="0[0-9\- ]{8,11}"
                  value={customer.phone}
                  onChange={(e) => setCustomer({ ...customer, phone: e.target.value })}
                />
              </label>
              {shop.deposit && <DepositNote deposit={shop.deposit} estimate={estimate} />}
              <p className="bk-fine">
                <SelfServiceNote shop={shop} /> ร้านใช้ชื่อและเบอร์นี้เพื่อติดต่อเรื่องนัดหมายนี้เท่านั้น
              </p>
            </form>
          </>
        )}
        {atCustomer && <BookingSubmitBar formId="booking-customer" disabled={busy || !liff.ready} busy={busy} price={estimate?.short} />}
        <PoweredBy />
      </main>
      {details && offerings.get(details.value) && (
        <OfferingDetails
          offering={offerings.get(details.value)}
          length={offeringLength(offerings.get(details.value))}
          price={offerings.get(details.value).price ? priceText(offerings.get(details.value).price) : null}
          available={details.available}
          reason={details.available ? null : REASON_TEXT[details.reason] ?? "ไม่ว่าง"}
          busy={busy}
          onClose={() => setDetails(null)}
          onChoose={() => {
            setDetails(null);
            choose("offering", details.value);
          }}
        />
      )}
    </CustomerFrame>
  );
}

const offeringLength = (offering) =>
  offering.durationMinutes ? formatMinutes(offering.durationMinutes) : `${formatMinutes(offering.minMinutes)}–${formatMinutes(offering.maxMinutes)}`;

// The extras for the chosen offering at the chosen time, grouped as the shop set them up. The engine
// says which can still be taken (and how many); the customer picks, then goes on.
function addonRule(g) {
  if (g.maxSelect === 1) return g.minSelect >= 1 ? "ต้องเลือก 1 อย่าง" : "เลือกได้ 1 อย่าง";
  if (g.minSelect > 0) return `ต้องเลือกอย่างน้อย ${g.minSelect} อย่าง`;
  if (g.maxSelect) return `เลือกได้ไม่เกิน ${g.maxSelect} อย่าง`;
  return "เลือกได้หลายอย่าง";
}

function addonPrice(a) {
  if (!a) return "";
  const amount = Number(a.amount);
  const parts = [amount ? `+${money(amount)}${ADDON_UNIT[a.priceUnit] ?? ""}` : "ไม่มีค่าใช้จ่าย"];
  if (a.addsMinutes) parts.push(`+${formatMinutes(a.addsMinutes)}`);
  return parts.join(" · ");
}

function AddonsStep({ view, info, initial, busy, onDone }) {
  const [picks, setPicks] = useState(() => Object.fromEntries(Object.entries(initial ?? {}).filter(([, q]) => q > 0)));
  const groups = view.groups ?? [];
  const inGroup = (id) => view.options.filter((o) => o.groupId === id);
  const count = (id, from = picks) => inGroup(id).filter((o) => from[o.value] > 0).length;
  const unmet = groups.filter((g) => count(g.id) < g.minSelect);

  function toggle(g, o) {
    setPicks((p) => {
      const next = { ...p };
      if (next[o.value] > 0) {
        delete next[o.value];
        return next;
      }
      if (g.maxSelect === 1) for (const x of inGroup(g.id)) delete next[x.value];
      else if (g.maxSelect && count(g.id, p) >= g.maxSelect) return p;
      next[o.value] = 1;
      return next;
    });
  }

  const setQuantity = (o, quantity) =>
    setPicks((p) => {
      const next = { ...p };
      if (quantity <= 0) delete next[o.value];
      else next[o.value] = Math.min(quantity, o.maxQuantity);
      return next;
    });

  const chosen = Object.keys(picks).length;
  return (
    <div className="bk-addons">
      {groups.map((g) => (
        <fieldset key={g.id} className="bk-addon-group">
          <legend>
            {g.name} <small>{addonRule(g)}</small>
          </legend>
          {inGroup(g.id).map((o) => {
            const a = info.get(o.value);
            const on = picks[o.value] > 0;
            const single = g.maxSelect === 1;
            return (
              <div key={o.value} className="bk-addon" data-selected={on} data-off={!o.available}>
                <button
                  type="button"
                  role={single ? "radio" : "checkbox"}
                  aria-checked={on}
                  className="bk-addon-pick"
                  data-testid="option-addons"
                  data-value={o.value}
                  disabled={busy || (!o.available && !on)}
                  onClick={() => toggle(g, o)}
                >
                  <span className={single ? "bk-choice-mark bk-choice-round" : "bk-choice-mark"} aria-hidden="true" />
                  <span className="bk-option-text">
                    <strong>{o.label}</strong>
                    {a?.description && <span className="bk-option-desc">{a.description}</span>}
                    <span className="bk-muted">{addonPrice(a)}</span>
                  </span>
                  {!o.available && <small className="bk-reason">{REASON_TEXT[o.reason] ?? "ไม่ว่าง"}</small>}
                </button>
                {on && o.maxQuantity > 1 && (
                  <span className="bk-stepper" role="group" aria-label={`จำนวน${o.label}`}>
                    <button type="button" aria-label="ลดจำนวน" disabled={busy} onClick={() => setQuantity(o, picks[o.value] - 1)}>−</button>
                    <output aria-live="polite">{picks[o.value]}</output>
                    <button type="button" aria-label="เพิ่มจำนวน" disabled={busy || picks[o.value] >= o.maxQuantity} onClick={() => setQuantity(o, picks[o.value] + 1)}>+</button>
                  </span>
                )}
              </div>
            );
          })}
        </fieldset>
      ))}
      {unmet.length > 0 && <p className="bk-muted">ยังต้องเลือก: {unmet.map((g) => `${g.name} (${addonRule(g)})`).join(" · ")}</p>}
      <button type="button" className="bk-primary" disabled={busy || unmet.length > 0} onClick={() => onDone(picks)}>
        {chosen ? `ต่อไป · เพิ่ม ${chosen} อย่าง` : "ไม่เพิ่ม ไปต่อ"}
      </button>
    </div>
  );
}

// All dates the server offers in one swipeable row, a week's worth on screen at a time.
function DateStrip({ options, today, optionProps }) {
  const strip = useRef(null);
  useEffect(() => {
    strip.current?.querySelector('[data-selected="true"]')?.scrollIntoView?.({ inline: "center", block: "nearest" });
  }, []);
  const month = (value, opts) => new Intl.DateTimeFormat("th-TH", { timeZone: "UTC", ...opts }).format(new Date(`${value}T00:00:00Z`));
  const first = options[0]?.value;
  const last = options[options.length - 1]?.value;
  const range = first ? (month(first, { month: "long" }) === month(last, { month: "long" }) ? month(first, { month: "long", year: "numeric" }) : `${month(first, { month: "short" })} – ${month(last, { month: "short", year: "numeric" })}`) : "";
  const scroll = (direction) => strip.current?.scrollBy({ left: direction * strip.current.clientWidth, behavior: "smooth" });
  return (
    <div className="bk-dates">
      <div className="bk-dates-head">
        <strong>{range}</strong>
        <div>
          <button type="button" className="bk-icon-button" aria-label="วันก่อนหน้า" onClick={() => scroll(-1)}>‹</button>
          <button type="button" className="bk-icon-button" aria-label="วันถัดไป" onClick={() => scroll(1)}>›</button>
        </div>
      </div>
      <div className="bk-date-strip" ref={strip}>
        {options.map((o) => (
          <button key={o.value} {...optionProps(o)}>
            <DateBody value={o.value} today={today} />
            {!o.available && <small className="bk-reason">{DAY_REASON_TEXT[o.reason] ?? "ไม่ว่าง"}</small>}
          </button>
        ))}
      </div>
    </div>
  );
}

// "วันอังคาร 3 พ.ย. 2569": the whole date on one line in a summary (the day in full, the month short)
const dayName = (value) => new Intl.DateTimeFormat("th-TH", { timeZone: "UTC", weekday: "long" }).format(new Date(`${value}T00:00:00Z`));
const dateOnly = (value) => new Intl.DateTimeFormat("th-TH", { timeZone: "UTC", day: "numeric", month: "short", year: "numeric" }).format(new Date(`${value}T00:00:00Z`));
const mediumDate = (value) => {
  const d = new Date(`${value}T00:00:00Z`);
  const part = (opts) => new Intl.DateTimeFormat("th-TH", { timeZone: "UTC", ...opts }).format(d);
  return `${part({ weekday: "long" })} ${part({ day: "numeric", month: "short", year: "numeric" })}`;
};
const shortDate = (value) => {
  const d = new Date(`${value}T00:00:00Z`);
  return `${SHORT_DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${new Intl.DateTimeFormat("th-TH", { timeZone: "UTC", month: "short" }).format(d)}`;
};

// spelled out here: Node and browsers abbreviate Thai weekdays differently (docs/HANDOFF.md §5)
const SHORT_DAYS = ["อา.", "จ.", "อ.", "พ.", "พฤ.", "ศ.", "ส."];

function DateBody({ value, today }) {
  const d = new Date(`${value}T00:00:00Z`);
  const part = (opts) => new Intl.DateTimeFormat("th-TH", { timeZone: "UTC", ...opts }).format(d);
  return (
    <>
      <span className="bk-day-label">{value === today ? "วันนี้" : SHORT_DAYS[d.getUTCDay()]}</span>
      <strong>{part({ day: "numeric" })}</strong>
      <span className="bk-day-month">{part({ month: "short" })}</span>
    </>
  );
}

// Before booking: the shop asks for a deposit by transfer (the exact amount comes with the booking)
function DepositNote({ deposit, estimate }) {
  const total = estimate?.short ? estimate.amount : null;
  const amount =
    deposit.mode === "full" ? total : deposit.mode === "percent" ? (total !== null ? Math.round((total * deposit.value) / 100) : null) : total !== null ? Math.min(deposit.value, total) : deposit.value;
  const what = amount !== null ? money(amount) : deposit.mode === "percent" ? `${deposit.value}% ของราคา` : "เต็มจำนวน";
  return (
    <p className="bk-notice">
      ร้านนี้ขอมัดจำ <b>{what}</b> โดยโอนเงิน · หลังกดยืนยันจะได้เลขบัญชี แล้วโอนและแนบสลิปภายใน {formatMinutes(deposit.holdMinutes ?? 10)}
    </p>
  );
}

function SelfServiceNote({ shop }) {
  const { cancel, reschedule, cutoffHours } = shop.selfService ?? {};
  const can = cancel && reschedule ? "เลื่อนหรือยกเลิก" : cancel ? "ยกเลิก" : reschedule ? "เลื่อน" : null;
  if (!can) return null;
  return <>{can}เองได้{cutoffHours > 0 ? `ถึง ${cutoffHours} ชม. ก่อนนัด` : ""} จากลิงก์ที่ได้หลังจอง ·</>;
}

// Wide screens: what has been picked so far, beside the step being answered.
function SummaryAside({ items, estimate, shop, onEdit, busy }) {
  return (
    <div className="bk-aside-card">
      {items.length === 0 ? (
        <>
          <h2>สรุปการจอง</h2>
          <p className="bk-muted">ยังไม่ได้เลือก · ทุกตัวเลือกแสดงตามคิวว่างจริงของร้าน</p>
        </>
      ) : (
        <BookingReview id="booking-aside-title" items={items} onEdit={onEdit} busy={busy} price={estimate} />
      )}
      <p className="bk-fine">
        <SelfServiceNote shop={shop} /> จองกับ {shop.name}
      </p>
    </div>
  );
}

function icsText(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/[,;]/g, (c) => `\\${c}`);
}
const icsTime = (iso) => new Date(iso).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");

function BookingDone({ shop, booking, items, selected, resourceWord, onSlip }) {
  const timeFormat = (iso) => new Intl.DateTimeFormat("th-TH", { timeZone: shop.timezone, hour: "2-digit", minute: "2-digit" }).format(new Date(iso));
  const dayPart = (opts) => new Intl.DateTimeFormat("th-TH", { timeZone: "UTC", ...opts }).format(new Date(`${selected.date}T00:00:00Z`));
  const when = booking.startAt && booking.endAt ? `${timeFormat(booking.startAt)}–${timeFormat(booking.endAt)} น.` : selected.time ? `${selected.time} น.` : "";
  const assigned = booking.resources?.map((r) => r.name).filter(Boolean).join(", ");
  const rows = items.filter((item) => item.step !== "date" && item.step !== "time");
  const managePath = booking.manageToken ? `/b/${shop.slug}/manage/${booking.manageToken}` : null;
  const held = booking.status === "held";

  function addToCalendar() {
    const service = rows.find((r) => r.step === "offering")?.value ?? "นัดหมาย";
    const link = managePath ? new URL(managePath, window.location.origin).toString() : window.location.href;
    const ics = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//Kiwmee//Booking//TH",
      "BEGIN:VEVENT",
      `UID:${booking.manageToken || booking.id || Date.now()}@kiwmee`,
      `DTSTAMP:${icsTime(new Date().toISOString())}`,
      `DTSTART:${icsTime(booking.startAt)}`,
      `DTEND:${icsTime(booking.endAt)}`,
      `SUMMARY:${icsText(`${service} · ${shop.name}`)}`,
      `DESCRIPTION:${icsText(`ดูหรือเปลี่ยนนัด: ${link}`)}`,
      "END:VEVENT",
      "END:VCALENDAR"
    ].join("\r\n");
    const url = URL.createObjectURL(new Blob([ics], { type: "text/calendar;charset=utf-8" }));
    const a = Object.assign(document.createElement("a"), { href: url, download: `${shop.slug}-booking.ics` });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  return (
    <section className="bk-done" data-testid="booking-done">
      <div className="bk-done-head">
        <span className="bk-done-icon" aria-hidden="true">
          <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12l5 5L20 7" /></svg>
        </span>
        <h1>{held ? "กันคิวไว้ให้แล้ว" : booking.status === "pending" ? "ส่งสลิปแล้ว รอร้านยืนยัน" : "จองสำเร็จ"}</h1>
        <p className="bk-muted">{held && booking.deposit ? "โอนมัดจำเพื่อยืนยันคิว" : `${shop.name} รอพบคุณ`}</p>
      </div>

      {booking.deposit && ["held", "pending"].includes(booking.status) && managePath && (
        <DepositBox
          deposit={booking.deposit}
          status={booking.status}
          deadline={booking.holdExpiresAt ? `${timeFormat(booking.holdExpiresAt)} น.` : null}
          uploadUrl={`/api/b/${shop.slug}/manage/${booking.manageToken}/slip`}
          onUploaded={onSlip}
        />
      )}

      <div className="bk-card bk-done-card">
        {selected.date && (
          <div className="bk-when">
            <span className="bk-date-tile" aria-hidden="true">
              <small>{dayPart({ month: "short" })}</small>
              <strong>{dayPart({ day: "numeric" })}</strong>
            </span>
            <div>
              <strong>{formatDate(selected.date, { long: true, shortMonth: true })}</strong>
              <span>{when}</span>
            </div>
          </div>
        )}
        <dl className="bk-summary">
          {rows.map((item) => (
            <div key={item.step}>
              <dt>{item.label}</dt>
              <dd>{item.value}</dd>
            </div>
          ))}
          {booking.resources?.length > 0 && selected.resourceId == null && (
            <div>
              <dt>{resourceWord}</dt>
              <dd>{assigned || "ร้านจัดให้"}</dd>
            </div>
          )}
          {booking.price?.total > 0 && (
            <div>
              <dt>ราคา</dt>
              <dd>
                <strong>{money(booking.price.total)}</strong>
              </dd>
            </div>
          )}
        </dl>
        {held && booking.holdExpiresAt && !booking.deposit && <p className="bk-notice">กรุณาชำระเงินภายใน {timeFormat(booking.holdExpiresAt)} น.</p>}
        {booking.startAt && booking.endAt && (
          <button type="button" className="bk-secondary" onClick={addToCalendar}>
            เพิ่มลงปฏิทิน
          </button>
        )}
      </div>

      {managePath && <ManageLink shop={shop} path={managePath} />}
      <a className="bk-text-button bk-center" href={`/b/${shop.slug}`}>
        จองคิวอีกครั้ง
      </a>
    </section>
  );
}

// The customer's own link to see, move or cancel this booking later (/b/<slug>/manage/<token>)
function ManageLink({ shop, path }) {
  const [copied, setCopied] = useState(false);
  const { cancel, reschedule, cutoffHours } = shop.selfService ?? {};
  const can = cancel && reschedule ? "เลื่อนหรือยกเลิก" : cancel ? "ยกเลิก" : reschedule ? "เลื่อน" : null;

  async function copy() {
    try {
      await navigator.clipboard.writeText(new URL(path, window.location.origin).toString());
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className="bk-link-box">
      <strong>{can ? `${can}นัดเองได้` : "ดูการจองนี้ได้ทุกเมื่อ"}</strong>
      <p>
        {can && cutoffHours > 0 ? `ถึง ${cutoffHours} ชม. ก่อนนัด ` : ""}ผ่านลิงก์ของการจองนี้ · เก็บลิงก์ไว้ เพราะเป็นของคุณคนเดียว
      </p>
      <div className="bk-link-actions">
        <a className="bk-primary" href={path} data-testid="manage-link">
          ดูการจองของฉัน
        </a>
        <button type="button" className="bk-secondary" onClick={copy}>
          {copied ? "คัดลอกแล้ว" : "คัดลอกลิงก์"}
        </button>
      </div>
    </div>
  );
}

// The shop's page, quietly signed by the platform
function PoweredBy() {
  return (
    <a className="bk-powered" href="/" target="_blank" rel="noreferrer">
      จองผ่าน <img src="/brand/kiwmee-logo.svg" alt="kiwmee" />
    </a>
  );
}

function OptionBody({ ask, option, offering, resource, resourceWord }) {
  if (ask === "offering" && offering) {
    const length = offeringLength(offering);
    return (
      <>
        <OfferingThumbnail offering={offering} />
        <span className="bk-option-text">
          <strong>{offering.name}</strong>
          {/* the price sits under the name, so a long name keeps the full width (LINE shows text larger) */}
          <span className="bk-option-meta">
            <span>{length}</span>
            {offering.price && <b className="bk-option-price">{priceText(offering.price)}</b>}
          </span>
        </span>
        <span className="bk-choice-mark" aria-hidden="true" />
      </>
    );
  }
  if (ask === "resource") return <ResourceChoice resource={resource} label={option.label} resourceWord={resourceWord} any={option.value === null} />;
  if (ask === "date") return <DateBody value={option.value} />;
  if (ask === "time") return <strong>{option.value}</strong>;
  if (ask === "duration") return <strong>{formatMinutes(option.value)}</strong>;
  if (ask === "party") return <strong>{option.value} คน</strong>;
  return <strong>{String(option.value)}</strong>;
}
