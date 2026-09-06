"use client";

import { useEffect, useMemo, useState } from "react";
import {
  STEPS,
  canContinue,
  conflictMessage,
  formatDateTime,
  formatMoney,
  selectedStaffName
} from "../src/ui/booking-flow-client.mjs";

const STEP_LABELS = {
  service: "บริการ",
  staff: "ช่าง",
  time: "วันเวลา",
  customer: "ข้อมูล",
  review: "ตรวจสอบ",
  success: "สำเร็จ"
};

function BookingClient() {
  const [step, setStep] = useState("service");
  const [services, setServices] = useState([]);
  const [staffList, setStaffList] = useState([]);
  const [slots, setSlots] = useState([]);
  const [selectedDate, setSelectedDate] = useState("2026-09-10");
  const [state, setState] = useState({
    service: null,
    staffChoice: "any",
    staff: null,
    slot: null,
    customer: {
      name: "",
      phone: "",
      contact_channel: "phone",
      notes: ""
    },
    booking: null
  });
  const [loading, setLoading] = useState({ services: true, staff: false, slots: false, confirm: false });
  const [error, setError] = useState("");

  useEffect(() => {
    fetchJson("/api/services")
      .then(setServices)
      .catch((err) => setError(err.message))
      .finally(() => setLoading((current) => ({ ...current, services: false })));
  }, []);

  useEffect(() => {
    if (!state.service) {
      return;
    }
    setLoading((current) => ({ ...current, staff: true }));
    setError("");
    fetchJson(`/api/staff?service_id=${encodeURIComponent(state.service.id)}`)
      .then((items) => {
        setStaffList(items);
        setState((current) => ({ ...current, staffChoice: "any", staff: null, slot: null }));
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading((current) => ({ ...current, staff: false })));
  }, [state.service?.id]);

  useEffect(() => {
    if (!state.service || step !== "time") {
      return;
    }
    loadSlots();
  }, [state.service?.id, state.staff?.id, state.staffChoice, selectedDate, step]);

  const currentStepIndex = STEPS.indexOf(step);
  const chosenStaffName = useMemo(() => selectedStaffName(state, staffList), [state, staffList]);

  function chooseService(service) {
    setState((current) => ({
      ...current,
      service,
      staffChoice: "any",
      staff: null,
      slot: null,
      booking: null
    }));
    setError("");
  }

  function chooseStaff(choice, staff = null) {
    setState((current) => ({ ...current, staffChoice: choice, staff, slot: null }));
    setError("");
  }

  async function loadSlots() {
    setLoading((current) => ({ ...current, slots: true }));
    setError("");
    const params = new URLSearchParams({
      service_id: state.service.id,
      date: selectedDate
    });
    if (state.staffChoice === "specific" && state.staff) {
      params.set("staff_id", state.staff.id);
    }

    try {
      const result = await fetchJson(`/api/availability?${params.toString()}`);
      setSlots(result.slots);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading((current) => ({ ...current, slots: false }));
    }
  }

  async function confirmBooking() {
    setLoading((current) => ({ ...current, confirm: true }));
    setError("");
    try {
      const booking = await fetchJson("/api/bookings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          customer: state.customer,
          service_id: state.service.id,
          staff_id: state.slot.staff_id,
          start_at: state.slot.start_at,
          source: "web"
        })
      });
      setState((current) => ({ ...current, booking }));
      setStep("success");
    } catch (err) {
      setError(conflictMessage(err));
      setStep("time");
      loadSlots();
    } finally {
      setLoading((current) => ({ ...current, confirm: false }));
    }
  }

  function nextStep() {
    const next = STEPS[currentStepIndex + 1];
    if (next) {
      setStep(next);
      setError("");
    }
  }

  function previousStep() {
    const previous = STEPS[currentStepIndex - 1];
    if (previous) {
      setStep(previous);
      setError("");
    }
  }

  return (
    <main className="app-shell">
      <Header />
      <section className="workspace booking-layout">
        <aside className="progress-panel" aria-label="ความคืบหน้าการจอง">
          <ol className="step-list">
            {STEPS.map((item, index) => (
              <li key={item} data-active={item === step}>
                <span className="step-dot">{index + 1}</span>
                <span>{STEP_LABELS[item]}</span>
              </li>
            ))}
          </ol>
        </aside>

        <section className="work-panel">
          {error ? <div className="state error">{error}</div> : null}

          {step === "service" ? (
            <StepSection title="เลือกบริการ" copy="แสดงเฉพาะบริการที่เปิดใช้งานจากระบบ">
              {loading.services ? <State text="กำลังโหลดบริการ" /> : null}
              {!loading.services && services.length === 0 ? <State text="ยังไม่มีบริการที่เปิดใช้งาน" /> : null}
              <div className="option-grid">
                {services.map((service) => (
                  <button
                    className="option-button"
                    data-selected={state.service?.id === service.id}
                    key={service.id}
                    onClick={() => chooseService(service)}
                  >
                    <span className="option-title">{service.name}</span>
                    <span className="meta">
                      <span>{service.duration_minutes} นาที</span>
                      <span>{formatMoney(service.price)}</span>
                    </span>
                    {service.description ? <p className="muted">{service.description}</p> : null}
                  </button>
                ))}
              </div>
            </StepSection>
          ) : null}

          {step === "staff" ? (
            <StepSection title="เลือกช่าง" copy="เลือกช่างที่ทำบริการนี้ได้ หรือให้ระบบหาเวลาว่างจากทุกคน">
              {loading.staff ? <State text="กำลังโหลดรายชื่อช่าง" /> : null}
              <div className="option-grid">
                <button
                  className="option-button"
                  data-selected={state.staffChoice === "any"}
                  onClick={() => chooseStaff("any")}
                >
                  <span className="option-title">ใครก็ได้</span>
                  <span className="muted">ระบบจะแสดง slot จากช่างทุกคนที่ทำบริการนี้ได้</span>
                </button>
                {staffList.map((staff) => (
                  <button
                    className="option-button"
                    data-selected={state.staff?.id === staff.id}
                    key={staff.id}
                    onClick={() => chooseStaff("specific", staff)}
                  >
                    <span className="option-title">{staff.name}</span>
                    <span className="muted">{staff.phone || "พร้อมให้บริการ"}</span>
                  </button>
                ))}
              </div>
            </StepSection>
          ) : null}

          {step === "time" ? (
            <StepSection title="เลือกวันและเวลา" copy="แสดงเฉพาะช่วงเวลาที่ระบบยืนยันแล้วว่าว่าง">
              <label className="field">
                <span>วันที่</span>
                <input value={selectedDate} onChange={(event) => setSelectedDate(event.target.value)} type="date" />
              </label>
              {loading.slots ? <State text="กำลังตรวจเวลาว่าง" /> : null}
              {!loading.slots && slots.length === 0 ? <State text="วันนี้ยังไม่มีเวลาว่าง กรุณาเลือกวันอื่น" /> : null}
              <div className="slot-grid">
                {slots.map((slot) => (
                  <button
                    className="slot-button"
                    data-selected={state.slot?.start_at === slot.start_at && state.slot?.staff_id === slot.staff_id}
                    key={`${slot.staff_id}-${slot.start_at}`}
                    onClick={() => setState((current) => ({ ...current, slot }))}
                  >
                    <span className="option-title">{timeOnly(slot.start_at)} - {timeOnly(slot.end_at)}</span>
                    <span className="muted">{staffList.find((staff) => staff.id === slot.staff_id)?.name || "ช่างที่ว่าง"}</span>
                  </button>
                ))}
              </div>
            </StepSection>
          ) : null}

          {step === "customer" ? (
            <StepSection title="ข้อมูลลูกค้า" copy="ใช้สำหรับยืนยันและจัดการนัด">
              <div className="field-grid two">
                <label className="field">
                  <span>ชื่อ</span>
                  <input
                    value={state.customer.name}
                    onChange={(event) => updateCustomer("name", event.target.value)}
                    placeholder="ชื่อผู้จอง"
                  />
                </label>
                <label className="field">
                  <span>เบอร์โทร</span>
                  <input
                    value={state.customer.phone}
                    onChange={(event) => updateCustomer("phone", event.target.value)}
                    placeholder="0800000000"
                  />
                </label>
              </div>
              <label className="field">
                <span>ช่องทางติดต่อ</span>
                <select
                  value={state.customer.contact_channel}
                  onChange={(event) => updateCustomer("contact_channel", event.target.value)}
                >
                  <option value="phone">โทรศัพท์</option>
                  <option value="line">LINE</option>
                  <option value="email">อีเมล</option>
                </select>
              </label>
              <label className="field">
                <span>หมายเหตุ</span>
                <textarea
                  value={state.customer.notes}
                  onChange={(event) => updateCustomer("notes", event.target.value)}
                  placeholder="รายละเอียดเพิ่มเติม เช่น แพ้สารเคมี หรือเวลาที่สะดวกติดต่อ"
                />
              </label>
            </StepSection>
          ) : null}

          {step === "review" ? (
            <StepSection title="ตรวจสอบการจอง" copy="ระบบจะยืนยันหลังตรวจเวลาว่างอีกครั้ง">
              <BookingSummary state={state} staffName={chosenStaffName} />
              <div className="state">นโยบายยกเลิก: ลูกค้ายกเลิกได้ก่อนเวลานัด 24 ชั่วโมง</div>
            </StepSection>
          ) : null}

          {step === "success" ? (
            <StepSection title="จองสำเร็จ" copy="ระบบยืนยัน booking แล้ว">
              <div className="state success">สถานะ: {state.booking?.status}</div>
              <div>
                <div className="muted">Booking reference</div>
                <div className="success-code">{state.booking?.id}</div>
              </div>
              <BookingSummary state={state} staffName={chosenStaffName} />
              <a className="primary-button" href={`/manage/${state.booking?.id}`}>จัดการนัดนี้</a>
            </StepSection>
          ) : null}

          {step !== "success" ? (
            <div className="actions">
              <button className="ghost-button" onClick={previousStep} disabled={currentStepIndex === 0}>
                ย้อนกลับ
              </button>
              {step === "review" ? (
                <button className="primary-button" onClick={confirmBooking} disabled={!canContinue(step, state) || loading.confirm}>
                  {loading.confirm ? "กำลังยืนยัน" : "ยืนยันการจอง"}
                </button>
              ) : (
                <button className="primary-button" onClick={nextStep} disabled={!canContinue(step, state)}>
                  ถัดไป
                </button>
              )}
            </div>
          ) : null}
        </section>
      </section>
    </main>
  );

  function updateCustomer(field, value) {
    setState((current) => ({
      ...current,
      customer: {
        ...current.customer,
        [field]: value
      }
    }));
  }
}

function Header() {
  return (
    <header className="topbar">
      <a className="brand" href="/">
        <strong>Salon Booking OS</strong>
        <span>จองคิวร้านเสริมสวย</span>
      </a>
      <nav className="nav-links">
        <a href="/assistant">ผู้ช่วยนัดหมาย</a>
        <a href="/manage">จัดการนัด</a>
        <a href="/admin">Admin</a>
      </nav>
    </header>
  );
}

function StepSection({ title, copy, children }) {
  return (
    <>
      <div className="panel-heading">
        <h1>{title}</h1>
        <p>{copy}</p>
      </div>
      {children}
    </>
  );
}

function BookingSummary({ state, staffName }) {
  return (
    <dl className="summary-list">
      <div>
        <dt>บริการ</dt>
        <dd>{state.service?.name || "-"}</dd>
      </div>
      <div>
        <dt>ช่าง</dt>
        <dd>{staffName}</dd>
      </div>
      <div>
        <dt>วันเวลา</dt>
        <dd>{formatDateTime(state.slot?.start_at)}</dd>
      </div>
      <div>
        <dt>ระยะเวลา</dt>
        <dd>{state.service?.duration_minutes || "-"} นาที</dd>
      </div>
      <div>
        <dt>ราคา</dt>
        <dd>{formatMoney(state.service?.price)}</dd>
      </div>
    </dl>
  );
}

function State({ text }) {
  return <div className="state">{text}</div>;
}

function timeOnly(value) {
  return new Intl.DateTimeFormat("th-TH", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Asia/Bangkok"
  }).format(new Date(value));
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body.error?.message || "request failed");
    error.code = body.error?.code;
    throw error;
  }
  return body.data;
}

export default BookingClient;
