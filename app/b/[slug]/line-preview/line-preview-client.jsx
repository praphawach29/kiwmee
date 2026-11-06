"use client";

import { useState } from "react";

export default function LinePreviewClient({ shop }) {
  const [richMenuOpen, setRichMenuOpen] = useState(true);
  const [copiedCode, setCopiedCode] = useState(false);
  const [copiedRef, setCopiedRef] = useState(false);
  const [toast, setToast] = useState(null);

  const showToast = (msg) => {
    setToast(msg);
    setTimeout(() => setToast(null), 2500);
  };

  const copyVoucher = () => {
    navigator.clipboard?.writeText("COMEBACK10");
    setCopiedCode(true);
    showToast("คัดลอกโค้ด COMEBACK10 เรียบร้อยแล้ว (ลด 10%)");
    setTimeout(() => setCopiedCode(false), 2000);
  };

  const copyRef = () => {
    navigator.clipboard?.writeText("RF-20260325-091");
    setCopiedRef(true);
    showToast("คัดลอกรหัสอ้างอิง RF-20260325-091 แล้ว");
    setTimeout(() => setCopiedRef(false), 2000);
  };

  return (
    <div style={{
      background: "#849EB5", // Authentic LINE chat background color
      minHeight: "100vh",
      display: "flex",
      flexDirection: "column",
      fontFamily: "'Plus Jakarta Sans', system-ui, -apple-system, sans-serif"
    }}>
      {/* LINE Top Navigation Bar */}
      <header style={{
        position: "sticky",
        top: 0,
        zIndex: 50,
        background: "rgba(255, 255, 255, 0.95)",
        backdropFilter: "blur(12px)",
        borderBottom: "1px solid rgba(0, 0, 0, 0.08)",
        padding: "10px 14px",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between"
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
          <a
            href={`/b/${shop.slug}/me`}
            style={{
              display: "flex",
              alignItems: "center",
              color: "#1B1640",
              textDecoration: "none",
              padding: "4px"
            }}
            aria-label="ย้อนกลับ"
          >
            <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M15 18l-6-6 6-6" />
            </svg>
          </a>

          <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
            <span style={{
              display: "grid",
              placeItems: "center",
              width: "18px",
              height: "18px",
              borderRadius: "50%",
              background: "#06C755", // LINE Green
              color: "#fff",
              fontSize: "10px",
              fontWeight: 800
            }}>
              ✓
            </span>
            <strong style={{ fontSize: "0.98rem", color: "#111827", fontWeight: 700 }}>
              Kiwmee คิวมี (Official)
            </strong>
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: "14px", color: "#4B5563" }}>
          <button type="button" style={{ background: "none", border: 0, padding: 0, cursor: "pointer", color: "inherit" }} aria-label="ค้นหา">
            <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="11" cy="11" r="8" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
          </button>
          <button type="button" style={{ background: "none", border: 0, padding: 0, cursor: "pointer", color: "inherit" }} aria-label="เมนู">
            <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="3" y1="12" x2="21" y2="12" />
              <line x1="3" y1="6" x2="21" y2="6" />
              <line x1="3" y1="18" x2="21" y2="18" />
            </svg>
          </button>
        </div>
      </header>

      {/* LINE Chat Messages Feed */}
      <main style={{
        flex: 1,
        maxWidth: "480px",
        width: "100%",
        margin: "0 auto",
        padding: "16px 14px 24px",
        boxSizing: "border-box",
        display: "flex",
        flexDirection: "column",
        gap: "14px"
      }}>
        {/* Date Divider Pill */}
        <div style={{ textAlign: "center", margin: "4px 0" }}>
          <span style={{
            background: "rgba(0, 0, 0, 0.22)",
            color: "#fff",
            padding: "3px 12px",
            borderRadius: "14px",
            fontSize: "0.74rem",
            fontWeight: 500,
            backdropFilter: "blur(4px)"
          }}>
            📅 25 มีนาคม 2568
          </span>
        </div>

        {/* Message Row with Kiwmee Avatar */}
        <div style={{ display: "flex", alignItems: "flex-start", gap: "10px", width: "100%" }}>
          {/* Avatar */}
          <div style={{
            width: "40px",
            height: "40px",
            borderRadius: "50%",
            background: "linear-gradient(135deg, #6A4CFF 0%, #3DDC97 100%)",
            padding: "2px",
            flex: "none",
            boxShadow: "0 2px 6px rgba(0,0,0,0.15)"
          }}>
            <div style={{
              width: "100%",
              height: "100%",
              borderRadius: "50%",
              background: "#1B1640",
              color: "#fff",
              display: "grid",
              placeItems: "center",
              fontWeight: 800,
              fontSize: "0.95rem"
            }}>
              KM
            </div>
          </div>

          {/* Flex Message Card */}
          <div style={{
            flex: 1,
            maxWidth: "340px",
            borderRadius: "18px",
            overflow: "hidden",
            boxShadow: "0 8px 24px rgba(0, 0, 0, 0.15)",
            background: "#fff"
          }}>
            {/* Flex Header: Purple Accent Banner */}
            <div style={{
              background: "linear-gradient(135deg, #6A4CFF 0%, #4F33E0 100%)",
              color: "#fff",
              padding: "14px 16px",
              position: "relative",
              overflow: "hidden"
            }}>
              <div style={{
                position: "absolute",
                right: "-12px",
                top: "-12px",
                width: "70px",
                height: "70px",
                borderRadius: "50%",
                background: "rgba(255, 255, 255, 0.12)",
                pointerEvents: "none"
              }} />

              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "8px" }}>
                <div>
                  <span style={{ fontSize: "0.72rem", color: "#E8E4F8", fontWeight: 700, letterSpacing: "0.04em", textTransform: "uppercase" }}>
                    Kiwmee Auto Refund
                  </span>
                  <h2 style={{ margin: "2px 0 0", fontSize: "1.05rem", fontWeight: 700, color: "#fff" }}>
                    แจ้งคืนเงินมัดจำสำเร็จ
                  </h2>
                </div>

                <span style={{
                  background: "#3DDC97",
                  color: "#065F46",
                  padding: "3px 9px",
                  borderRadius: "12px",
                  fontSize: "0.7rem",
                  fontWeight: 800,
                  flex: "none",
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "3px"
                }}>
                  <span>✓</span>
                  <span>อนุมัติแล้ว 100%</span>
                </span>
              </div>
            </div>

            {/* Flex Body */}
            <div style={{ padding: "14px 16px", display: "grid", gap: "12px", background: "#fff" }}>
              {/* Refund Hero Amount Box */}
              <div style={{
                borderRadius: "14px",
                background: "#F7F5FF",
                padding: "14px",
                textAlign: "center",
                display: "grid",
                gap: "4px"
              }}>
                <span style={{ fontSize: "0.78rem", color: "#5F5A7A" }}>
                  ยอดเงินคืนเข้าบัญชี
                </span>
                <strong style={{ fontSize: "1.8rem", color: "#6A4CFF", fontWeight: 800 }}>
                  ฿500.00
                </strong>
                <span style={{
                  display: "inline-block",
                  margin: "0 auto",
                  background: "rgba(61, 220, 151, 0.25)",
                  color: "#0B7A50",
                  padding: "2px 10px",
                  borderRadius: "10px",
                  fontSize: "0.72rem",
                  fontWeight: 700
                }}>
                  ● คืนเต็มจำนวน (ไม่มีหักค่าธรรมเนียม)
                </span>
              </div>

              {/* Transaction Detail Rows */}
              <div style={{ display: "grid", gap: "8px", fontSize: "0.8rem" }}>
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span style={{ color: "#5F5A7A" }}>ช่องทางคืนเงิน</span>
                  <strong style={{ color: "#1B1640" }}>PromptPay (081-xxx-8899)</strong>
                </div>

                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <span style={{ color: "#5F5A7A" }}>รหัสอ้างอิงคืนเงิน</span>
                  <button
                    type="button"
                    onClick={copyRef}
                    style={{
                      background: "none",
                      border: 0,
                      padding: 0,
                      cursor: "pointer",
                      display: "inline-flex",
                      alignItems: "center",
                      gap: "4px",
                      color: "#6A4CFF",
                      fontWeight: 700,
                      fontFamily: "monospace"
                    }}
                  >
                    <span>RF-20260325-091</span>
                    <span style={{ fontSize: "12px" }}>{copiedRef ? "✓" : "📋"}</span>
                  </button>
                </div>

                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span style={{ color: "#5F5A7A" }}>รหัสนัดหมายเดิม</span>
                  <span style={{ color: "#1B1640", fontWeight: 600 }}>#KM-8824</span>
                </div>

                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span style={{ color: "#5F5A7A" }}>บริการที่ยกเลิก</span>
                  <span style={{ color: "#1B1640", fontWeight: 500, textAlign: "right" }}>ตัดแต่งทรงผม + Olaplex</span>
                </div>

                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span style={{ color: "#5F5A7A" }}>วันเวลาทำรายการ</span>
                  <span style={{ color: "#1B1640" }}>วันนี้, 14:35 น.</span>
                </div>

                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span style={{ color: "#5F5A7A" }}>เงื่อนไข</span>
                  <span style={{ color: "#0B7A50", fontWeight: 600 }}>ยกเลิกล่วงหน้า &gt; 2 ชม.</span>
                </div>
              </div>

              {/* Comeback Coupon Card */}
              <div style={{
                borderRadius: "12px",
                background: "linear-gradient(135deg, #F7F5FF 0%, #FFFFFF 100%)",
                border: "1.5px dashed #6A4CFF",
                padding: "10px 12px",
                display: "grid",
                gap: "4px"
              }}>
                <span style={{ fontSize: "0.72rem", color: "#6A4CFF", fontWeight: 700 }}>
                  🎁 โค้ดส่วนลดปลอบใจ 10% สำหรับการจองครั้งถัดไป
                </span>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <strong style={{ fontSize: "1rem", color: "#1B1640", letterSpacing: "0.06em" }}>
                    COMEBACK10
                  </strong>
                  <button
                    type="button"
                    onClick={copyVoucher}
                    style={{
                      background: "#6A4CFF",
                      color: "#fff",
                      border: 0,
                      borderRadius: "8px",
                      padding: "4px 10px",
                      fontSize: "0.74rem",
                      fontWeight: 700,
                      cursor: "pointer"
                    }}
                  >
                    {copiedCode ? "คัดลอกแล้ว ✓" : "คัดลอกโค้ด"}
                  </button>
                </div>
                <span style={{ fontSize: "0.68rem", color: "#5F5A7A" }}>
                  ใช้ได้ 30 วัน • ไม่จำกัดยอดขั้นต่ำ
                </span>
              </div>
            </div>

            {/* Flex Actions Footer */}
            <div style={{ padding: "0 16px 14px", display: "grid", gap: "8px" }}>
              <a
                href={`/b/${shop.slug}/me`}
                style={{
                  display: "block",
                  padding: "10px",
                  borderRadius: "12px",
                  background: "#6A4CFF",
                  color: "#fff",
                  fontSize: "0.85rem",
                  fontWeight: 700,
                  textAlign: "center",
                  textDecoration: "none",
                  boxShadow: "0 3px 10px rgba(106, 76, 255, 0.25)"
                }}
              >
                ตรวจสอบสถานะ / ใบเสร็จ LIFF
              </a>

              <a
                href={`/b/${shop.slug}`}
                style={{
                  display: "block",
                  padding: "10px",
                  borderRadius: "12px",
                  background: "#F4F5F7",
                  color: "#1B1640",
                  fontSize: "0.85rem",
                  fontWeight: 600,
                  textAlign: "center",
                  textDecoration: "none"
                }}
              >
                จองคิวใหม่ทันที
              </a>
            </div>
          </div>
        </div>
      </main>

      {/* LINE Rich Menu Drawer */}
      <footer style={{
        marginTop: "auto",
        position: "sticky",
        bottom: 0,
        zIndex: 50,
        background: "#fff",
        boxShadow: "0 -4px 20px rgba(0, 0, 0, 0.12)",
        borderTopLeftRadius: "18px",
        borderTopRightRadius: "18px",
        overflow: "hidden"
      }}>
        {/* Rich Menu Drawer Toggle Button */}
        <button
          type="button"
          onClick={() => setRichMenuOpen((v) => !v)}
          style={{
            width: "100%",
            padding: "8px 14px",
            background: "#F4F5F7",
            border: 0,
            borderBottom: "1px solid rgba(0,0,0,0.06)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: "6px",
            fontSize: "0.78rem",
            fontWeight: 700,
            color: "#4B5563",
            cursor: "pointer"
          }}
        >
          <span>{richMenuOpen ? "▼ ซ่อนเมนู / Hide Menu" : "▲ เมนู / Menu"}</span>
        </button>

        {/* 6-Grid Rich Menu */}
        {richMenuOpen && (
          <div style={{
            maxWidth: "480px",
            margin: "0 auto",
            display: "grid",
            gridTemplateColumns: "repeat(3, 1fr)",
            gap: "4px",
            padding: "4px",
            background: "#E5E7EB"
          }}>
            {/* Tile 1: จองคิวบริการ (Hero Accent) */}
            <a
              href={`/b/${shop.slug}`}
              style={{
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                padding: "12px 6px",
                borderRadius: "12px",
                background: "linear-gradient(135deg, #6A4CFF 0%, #4F33E0 100%)",
                color: "#fff",
                textDecoration: "none",
                minHeight: "84px",
                boxShadow: "0 2px 8px rgba(106, 76, 255, 0.2)"
              }}
            >
              <span style={{ fontSize: "22px", marginBottom: "2px" }}>📅</span>
              <strong style={{ fontSize: "0.82rem", fontWeight: 700, textAlign: "center" }}>จองคิวบริการ</strong>
              <span style={{ fontSize: "0.68rem", color: "#3DDC97", fontWeight: 700, marginTop: "2px" }}>แนะนำ • รวดเร็ว</span>
            </a>

            {/* Tile 2: เช็คคิวของฉัน */}
            <a
              href={`/b/${shop.slug}/me`}
              style={{
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                padding: "12px 6px",
                borderRadius: "12px",
                background: "#fff",
                color: "#1B1640",
                textDecoration: "none",
                minHeight: "84px"
              }}
            >
              <span style={{ fontSize: "22px", marginBottom: "2px" }}>🎫</span>
              <strong style={{ fontSize: "0.82rem", fontWeight: 700, textAlign: "center" }}>เช็คคิวของฉัน</strong>
              <span style={{ fontSize: "0.68rem", color: "#5F5A7A", marginTop: "2px" }}>เลื่อน / ยกเลิก</span>
            </a>

            {/* Tile 3: บริการ & ราคา */}
            <a
              href={`/b/${shop.slug}/services`}
              style={{
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                padding: "12px 6px",
                borderRadius: "12px",
                background: "#fff",
                color: "#1B1640",
                textDecoration: "none",
                minHeight: "84px"
              }}
            >
              <span style={{ fontSize: "22px", marginBottom: "2px" }}>✂️</span>
              <strong style={{ fontSize: "0.82rem", fontWeight: 700, textAlign: "center" }}>บริการ & ราคา</strong>
              <span style={{ fontSize: "0.68rem", color: "#5F5A7A", marginTop: "2px" }}>เมนูซาลอน</span>
            </a>

            {/* Tile 4: คูปอง & ดีลพิเศษ */}
            <a
              href={`/b/${shop.slug}/me?tab=vouchers`}
              style={{
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                padding: "12px 6px",
                borderRadius: "12px",
                background: "#fff",
                color: "#1B1640",
                textDecoration: "none",
                minHeight: "84px"
              }}
            >
              <span style={{ fontSize: "22px", marginBottom: "2px" }}>🎟️</span>
              <strong style={{ fontSize: "0.82rem", fontWeight: 700, textAlign: "center" }}>คูปอง & ดีลพิเศษ</strong>
              <span style={{ fontSize: "0.68rem", color: "#0B7A50", fontWeight: 700, marginTop: "2px" }}>ลดสูงสุด 40%</span>
            </a>

            {/* Tile 5: บัตรสมาชิก & แต้มสะสม */}
            <a
              href={`/b/${shop.slug}/me?tab=rewards`}
              style={{
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                padding: "12px 6px",
                borderRadius: "12px",
                background: "#fff",
                color: "#1B1640",
                textDecoration: "none",
                minHeight: "84px"
              }}
            >
              <span style={{ fontSize: "22px", marginBottom: "2px" }}>👑</span>
              <strong style={{ fontSize: "0.82rem", fontWeight: 700, textAlign: "center" }}>สะสมแต้ม</strong>
              <span style={{ fontSize: "0.68rem", color: "#5F5A7A", marginTop: "2px" }}>Kiwmee Rewards</span>
            </a>

            {/* Tile 6: คุยกับแอดมิน */}
            <button
              type="button"
              onClick={() => showToast("เปิดช่องทางสนทนาแอดมิน Kiwmee พร้อมให้บริการค่ะ")}
              style={{
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                padding: "12px 6px",
                borderRadius: "12px",
                background: "#fff",
                color: "#1B1640",
                border: 0,
                cursor: "pointer",
                minHeight: "84px"
              }}
            >
              <span style={{ fontSize: "22px", marginBottom: "2px" }}>💬</span>
              <strong style={{ fontSize: "0.82rem", fontWeight: 700, textAlign: "center" }}>คุยกับแอดมิน</strong>
              <span style={{ fontSize: "0.68rem", color: "#5F5A7A", marginTop: "2px" }}>ปรึกษาช่างทำผม</span>
            </button>
          </div>
        )}
      </footer>

      {/* Toast Notification */}
      {toast && (
        <div style={{
          position: "fixed",
          top: "60px",
          left: "50%",
          transform: "translateX(-50%)",
          background: "#1B1640",
          color: "#fff",
          padding: "10px 20px",
          borderRadius: "30px",
          fontSize: "0.85rem",
          fontWeight: 600,
          zIndex: 9999,
          boxShadow: "0 6px 20px rgba(0,0,0,0.25)"
        }}>
          {toast}
        </div>
      )}
    </div>
  );
}

