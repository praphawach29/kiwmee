"use client";

import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { scanUrl, bookingCode } from "../../../src/v2/scan-codes.js";

/** A QR drawn in the browser (nothing leaves the phone to make it) */
export function QrImage({ text, label, size = 200 }) {
  const [src, setSrc] = useState(null);
  useEffect(() => {
    let live = true;
    QRCode.toDataURL(text, { errorCorrectionLevel: "M", margin: 1, width: size * 2, color: { dark: "#1B1640", light: "#FFFFFF" } })
      .then((url) => live && setSrc(url), () => live && setSrc(null));
    return () => { live = false; };
  }, [text, size]);
  return (
    <span className="bk-qr" style={{ width: size, height: size }}>
      {src ? <img src={src} alt={label} width={size} height={size} /> : null}
    </span>
  );
}

/** The booking's check-in QR: the shop scans it at the desk, or types the code under it */
export function CheckinQr({ slug, id, open: startOpen = false }) {
  const [open, setOpen] = useState(startOpen);
  const [origin, setOrigin] = useState("");
  useEffect(() => setOrigin(window.location.origin), []);
  if (!id) return null;
  if (!open) {
    return (
      <button type="button" className="bk-secondary bk-qr-button" onClick={() => setOpen(true)}>
        <QrIcon /> QR เช็กอินที่ร้าน
      </button>
    );
  }
  return (
    <div className="bk-checkin" aria-label="QR เช็กอิน">
      {origin && <QrImage text={scanUrl(origin, slug, "b", id)} label={`QR เช็กอิน รหัส ${bookingCode(id)}`} />}
      <strong className="bk-checkin-code">{bookingCode(id)}</strong>
      <small>แสดง QR นี้ให้พนักงานตอนมาถึง · หรือบอกรหัสการจอง</small>
      <button type="button" className="bk-text-button" onClick={() => setOpen(false)}>ซ่อน QR</button>
    </div>
  );
}

export function QrIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" />
      <path d="M14 14h3v3h-3zM20 14v.01M14 20h.01M17 20h4M20 17v3" />
    </svg>
  );
}
