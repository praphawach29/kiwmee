"use client";
import { useEffect, useRef, useState } from "react";
export default function AssistantClient() {
  const [messages, setMessages] = useState([]);
  const [sessionId, setSessionId] = useState(null);
  const [input, setInput] = useState("");
  const [date, setDate] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const end = useRef(null);
  const latest = messages.filter((m) => m.role === "assistant").at(-1);
  useEffect(() => { end.current?.scrollIntoView({ block: "nearest", behavior: "smooth" }); }, [messages, loading]);
  async function send(message, label = null) {
    if (loading || !message.trim() || message.length > 2000) return;
    setLoading(true); setInput(""); setError("");
    setMessages((rows) => [...rows, { role: "user", message: label ?? (message.match(/^[0-9a-f-]{36} /) ? "เลือกเวลานี้" : message) }]);
    try {
      const response = await fetch("/api/ai/receptionist", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ session_id: sessionId, message }) });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error?.message ?? "ส่งข้อความไม่สำเร็จ");
      setSessionId(body.data.session_id);
      setMessages((rows) => [...rows, { role: "assistant", ...body.data }]);
    } catch { setError("เชื่อมต่อระบบไม่ได้ กรุณาลองใหม่อีกครั้ง"); } finally { setLoading(false); }
  }
  return <main className="receptionist">
    <header className="receptionist-header"><a href="/">Salon Booking OS</a><nav><a href="/">จองคิว</a><a href="/manage">จัดการนัด</a></nav></header>
    <div className="receptionist-title"><h1>ผู้ช่วยนัดหมาย</h1><span>บริการลูกค้า · โหมดทดลอง</span></div>
    <section className="receptionist-chat" aria-label="บทสนทนา" aria-live="polite">
      <div className="receptionist-message"><strong>ผู้ช่วยร้าน</strong><p>สวัสดีค่ะ ต้องการจองคิวหรือดูนัดเดิมคะ</p>
        {!messages.length && <button onClick={() => send("บริการ")} disabled={loading}>ดูบริการ</button>}
      </div>
      {messages.map((row, index) => <article key={index} className={`receptionist-message ${row.role}`}>
        <strong>{row.role === "user" ? "คุณ" : "ผู้ช่วยร้าน"}</strong><p>{row.message}</p>
        {row.state?.review && <section className="receptionist-card" aria-label="ยืนยันรายการ">
          <h2>{row.state.review.action === "cancel" ? "ตรวจสอบการยกเลิก" : "ตรวจสอบนัดหมาย"}</h2>
          <dl><div><dt>บริการ</dt><dd>{row.state.review.service?.name}</dd></div>
            <div><dt>ช่าง</dt><dd>{row.state.review.staff?.name}</dd></div>
            <div><dt>วันและเวลา</dt><dd>{formatDate(row.state.review.slot?.start_at)}</dd></div>
            <div><dt>ระยะเวลา / ราคา</dt><dd>{row.state.review.service?.duration_minutes} นาที · {row.state.review.service?.price ?? "สอบถามร้าน"} บาท</dd></div>
            <div><dt>ชื่อ / เบอร์ลงท้าย</dt><dd>{row.state.review.customer_name} · {row.state.review.phone_last4}</dd></div></dl>
          <p>ยกเลิกก่อนเวลานัดอย่างน้อย {row.state.review.cancellation_window_hours} ชั่วโมง หากเลยกำหนดกรุณาติดต่อร้าน</p>
          <button className="receptionist-primary" disabled={loading || row !== latest} onClick={() => send("ยืนยัน")}>ยืนยัน</button>
        </section>}
        {row.state?.booking && <section className="receptionist-card" aria-label="ข้อมูลนัดหมาย">
          <h2>{row.state.stage === "success" ? "รายการสำเร็จ" : "นัดหมายของคุณ"}</h2>
          <p>{row.state.service?.name} · {row.state.staff?.name}</p><p>{formatDate(row.state.booking.start_at)}</p>
          <p>สถานะ: {row.state.booking.status}</p><p>รหัสนัด: <span className="receptionist-reference">{row.state.booking.id}</span></p>
          <a href={`/manage/${row.state.booking.id}`}>จัดการนัดหมาย</a>
        </section>}
        {row === latest && !loading && <div className="receptionist-choices">{row.choices?.map((choice) => <button key={choice.value} onClick={() => send(choice.value, choice.label)}>{choice.label}</button>)}</div>}
        {row.handoff && <p className="receptionist-handoff" role="status">ต้องติดต่อพนักงานของร้านเพื่อดำเนินการต่อ</p>}
      </article>)}
      {loading && <p role="status">กำลังตรวจสอบข้อมูล…</p>}
      <div ref={end} />
    </section>
    {error && <p className="receptionist-error" role="alert">{error}</p>}
    {latest?.state?.stage === "date" && <form className="receptionist-date" onSubmit={(e) => { e.preventDefault(); send(date); }}>
      <label>วันที่นัด<input type="date" aria-label="วันที่นัด" value={date} onChange={(e) => setDate(e.target.value)} /></label>
      <button disabled={loading || !date}>ตรวจเวลาว่าง</button>
    </form>}
    <form className="receptionist-compose" onSubmit={(e) => { e.preventDefault(); send(input); }}>
      <label className="receptionist-input">ข้อความ<textarea aria-label="ข้อความ" rows={2} maxLength={2000} value={input} onChange={(e) => setInput(e.target.value)} /></label>
      <button className="receptionist-primary" disabled={loading || !input.trim()}>ส่งข้อความ</button>
    </form>
    <footer><button onClick={() => { setSessionId(null); setMessages([]); setError(""); setInput(""); }} disabled={loading}>เริ่มใหม่</button><button onClick={() => send("คุยกับพนักงาน")} disabled={loading}>ติดต่อพนักงาน</button></footer>
  </main>;
}
function formatDate(value) { return value ? new Intl.DateTimeFormat("th-TH", { timeZone: "Asia/Bangkok", dateStyle: "medium", timeStyle: "short" }).format(new Date(value)) : ""; }
