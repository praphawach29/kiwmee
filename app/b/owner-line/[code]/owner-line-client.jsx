"use client";

import { useEffect, useRef, useState } from "react";
import { useLiff } from "../../[slug]/use-liff.jsx";

// The owner's side of linking LINE (B8): sign in to LINE, send the ID token with the one-time code.
export default function OwnerLineClient({ code, liffId }) {
  const liff = useLiff(liffId);
  const [state, setState] = useState({ status: "idle" });
  const sent = useRef(false);

  useEffect(() => {
    if (!liff.ready || !liff.idToken || sent.current) return;
    sent.current = true;
    setState({ status: "linking" });
    fetch("/api/line/owner-link", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code, lineIdToken: liff.idToken })
    })
      .then(async (response) => {
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(payload?.error?.message || "เชื่อม LINE ไม่สำเร็จ ลองใหม่อีกครั้ง");
        setState({ status: "linked", ...payload.data });
      })
      .catch((error) => setState({ status: "error", message: error.message }));
  }, [liff.ready, liff.idToken, code]);

  let body;
  if (!liffId) {
    body = <p className="ol-text">ระบบ LINE ของ Kiwmee ยังไม่พร้อม กรุณาติดต่อทีมงาน</p>;
  } else if (!liff.ready || state.status === "linking") {
    body = <p className="ol-text" role="status">กำลังเชื่อมบัญชี LINE…</p>;
  } else if (state.status === "linked") {
    body = (
      <>
        <p className="ol-ok" role="status">✓ เชื่อม LINE{state.lineName ? ` (${state.lineName})` : ""} แล้ว</p>
        <p className="ol-text">Kiwmee จะแจ้งเตือนในแชตนี้เมื่อแพ็กเกจใกล้หมด เงินในกระเป๋าไม่พอต่ออายุ หรือใช้งานใกล้เต็มโควตา</p>
        {!state.delivered && (
          <p className="ol-hint">ยังส่งข้อความหาคุณไม่ได้ · เพิ่ม Kiwmee เป็นเพื่อนใน LINE ก่อน แล้วกด "ส่งข้อความทดสอบ" ในแดชบอร์ด</p>
        )}
        <p className="ol-text">กลับไปที่แดชบอร์ดได้เลย หน้านี้ปิดได้</p>
      </>
    );
  } else if (state.status === "error") {
    body = <p className="ol-error" role="alert">{state.message}</p>;
  } else if (!liff.idToken) {
    body = (
      <>
        <p className="ol-text">เข้าสู่ระบบ LINE เพื่อรับแจ้งเตือนเรื่องแพ็กเกจของร้านจาก Kiwmee</p>
        {liff.login
          ? <button type="button" className="ol-button" onClick={liff.login}>เข้าสู่ระบบด้วย LINE</button>
          : <p className="ol-hint">เปิดลิงก์นี้ในแอป LINE บนมือถือ (สแกน QR จากแดชบอร์ดด้วยกล้องหรือแอป LINE)</p>}
      </>
    );
  }

  return (
    <main className="ol-page">
      <section className="ol-card">
        <img src="/brand/kiwmee-logo.svg" alt="Kiwmee" className="ol-logo" />
        <h1>รับแจ้งเตือนทาง LINE</h1>
        {body}
      </section>
    </main>
  );
}
