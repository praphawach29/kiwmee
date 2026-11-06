"use client";

import { useState } from "react";
import CustomerFrame from "../customer-frame.jsx";
import { useLiff } from "../use-liff.jsx";

const IMPRESSION_CHIPS = [
  "✨ ทรงผมตรงเรฟมาก",
  "💆 สระไดร์นวดศีรษะฟิน",
  "☕ บรรยากาศผ่อนคลาย",
  "⏰ ตรงต่อเวลา ไม่ต้องรอนาน",
  "🧴 ผลิตภัณฑ์พรีเมียม กลิ่นหอม",
  "🧼 ความสะอาดดีเยี่ยม",
  "💬 ให้คำปรึกษาจริงใจ",
  "💅 ผลงานละเอียดประณีต"
];

const RATING_FEEDBACK = {
  5: "5/5 ประทับใจมากที่สุด! ❤️",
  4: "4/5 ดีมาก ประทับใจ ✨",
  3: "3/5 ปานกลาง พอใช้ได้ 👍",
  2: "2/5 ควรปรับปรุง 😐",
  1: "1/5 ไม่พึงพอใจ 😞"
};

export default function ReviewClient({ shop, bookingId, liffId }) {
  const liff = useLiff(liffId);
  const [rating, setRating] = useState(5);
  const [subRatings, setSubRatings] = useState({ craft: 5, service: 5, cleanliness: 5 });
  const [selectedChips, setSelectedChips] = useState(["✨ ทรงผมตรงเรฟมาก", "💆 สระไดร์นวดศีรษะฟิน"]);
  const [comment, setComment] = useState("");
  const [photos, setPhotos] = useState([]);
  const [consentShowcase, setConsentShowcase] = useState(true);
  const [isAnonymous, setIsAnonymous] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isSubmitted, setIsSubmitted] = useState(false);

  const toggleChip = (chip) => {
    setSelectedChips((prev) =>
      prev.includes(chip) ? prev.filter((c) => c !== chip) : [...prev, chip]
    );
  };

  const handlePhotoUpload = (e) => {
    const files = Array.from(e.target.files || []);
    if (files.length === 0) return;
    const newPhotos = files.slice(0, 3 - photos.length).map((file) => ({
      name: file.name,
      url: URL.createObjectURL(file)
    }));
    setPhotos((prev) => [...prev, ...newPhotos]);
  };

  const removePhoto = (idx) => {
    setPhotos((prev) => prev.filter((_, i) => i !== idx));
  };

  const totalPoints = 50 + (photos.length > 0 ? 20 : 0);

  const handleSubmit = (e) => {
    e?.preventDefault();
    setIsSubmitting(true);
    setTimeout(() => {
      setIsSubmitting(false);
      setIsSubmitted(true);
    }, 600);
  };

  const displayRef = bookingId && bookingId !== "demo"
    ? `#KM-${String(bookingId).slice(0, 4).toUpperCase()}`
    : "#KM-8824";

  return (
    <CustomerFrame>
      <main className="bk-shell" style={{ paddingBottom: "110px", maxWidth: "480px", margin: "0 auto" }}>
        {/* Top Header */}
        <header className="bk-topbar" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "12px" }}>
          <a href={`/b/${shop.slug}/me`} className="bk-icon-btn" aria-label="ปิด">
            <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </a>
          <h1 style={{ margin: 0, fontSize: "1.05rem", fontWeight: 700, color: "var(--ink)" }}>
            รีวิวและให้คะแนน
          </h1>
          <div style={{ width: "36px" }} />
        </header>

        {/* Success Modal / State */}
        {isSubmitted ? (
          <div style={{
            background: "#fff",
            borderRadius: "24px",
            border: "1px solid var(--line-soft)",
            padding: "32px 20px",
            textAlign: "center",
            boxShadow: "0 10px 30px rgba(106, 76, 255, 0.1)",
            display: "grid",
            gap: "16px",
            marginTop: "16px"
          }}>
            <div style={{
              width: "72px",
              height: "72px",
              borderRadius: "50%",
              background: "linear-gradient(135deg, #3DDC97 0%, #0B7A50 100%)",
              color: "#fff",
              display: "grid",
              placeItems: "center",
              margin: "0 auto",
              fontSize: "36px",
              boxShadow: "0 6px 20px rgba(61, 220, 151, 0.35)"
            }}>
              ✓
            </div>

            <div>
              <h2 style={{ margin: 0, fontSize: "1.3rem", fontWeight: 800, color: "var(--ink)" }}>
                ส่งรีวิวสำเร็จ ขอบคุณค่ะ! 🎉
              </h2>
              <p style={{ margin: "6px 0 0", fontSize: "0.88rem", color: "var(--muted)", lineHeight: 1.4 }}>
                ความเห็นของคุณช่วยเป็นกำลังใจและพัฒนาบริการของ {shop.name}
              </p>
            </div>

            <div style={{
              background: "linear-gradient(135deg, #F7F5FF 0%, #FFFFFF 100%)",
              border: "1.5px dashed var(--grape)",
              borderRadius: "18px",
              padding: "16px",
              display: "grid",
              gap: "6px"
            }}>
              <span style={{ fontSize: "0.8rem", color: "var(--muted)", fontWeight: 600 }}>คะแนนสะสมที่ได้รับ</span>
              <strong style={{ fontSize: "1.8rem", color: "var(--grape-deep)", fontWeight: 800 }}>
                +{totalPoints} แต้ม
              </strong>
              <span style={{ fontSize: "0.78rem", color: "var(--mint-deep)", fontWeight: 600 }}>
                ✨ โอนเข้า Kiwmee Points ของคุณเรียบร้อยแล้ว
              </span>
            </div>

            <div style={{ display: "grid", gap: "10px", marginTop: "8px" }}>
              <a
                href={`/b/${shop.slug}/me?tab=rewards`}
                style={{
                  display: "block",
                  padding: "12px",
                  borderRadius: "14px",
                  background: "var(--grape)",
                  color: "#fff",
                  fontWeight: 700,
                  fontSize: "0.92rem",
                  textDecoration: "none",
                  boxShadow: "0 4px 14px rgba(106, 76, 255, 0.3)"
                }}
              >
                ดูแต้มสะสมและสิทธิพิเศษ (Rewards)
              </a>
              <a
                href={`/b/${shop.slug}/me`}
                style={{
                  display: "block",
                  padding: "12px",
                  borderRadius: "14px",
                  background: "var(--bg)",
                  color: "var(--ink)",
                  fontWeight: 600,
                  fontSize: "0.88rem",
                  textDecoration: "none"
                }}
              >
                กลับสู่หน้าการจองของฉัน
              </a>
            </div>
          </div>
        ) : (
          <form onSubmit={handleSubmit} style={{ display: "grid", gap: "14px" }}>
            {/* 1. Reward Incentive Hero Banner */}
            <div style={{
              position: "relative",
              overflow: "hidden",
              borderRadius: "20px",
              background: "linear-gradient(135deg, #6A4CFF 0%, #4F33E0 100%)",
              color: "#fff",
              padding: "16px 18px",
              boxShadow: "0 6px 20px rgba(106, 76, 255, 0.2)"
            }}>
              <div style={{ position: "absolute", right: "-10px", top: "-10px", width: "80px", height: "80px", borderRadius: "50%", background: "rgba(255,255,255,0.12)", pointerEvents: "none" }} />
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "4px" }}>
                <span style={{ fontSize: "1.05rem", fontWeight: 700 }}>ขอบคุณที่มาใช้บริการ ✨</span>
                <span style={{
                  background: "linear-gradient(90deg, #3DDC97 0%, #12B981 100%)",
                  color: "#065F46",
                  padding: "3px 10px",
                  borderRadius: "12px",
                  fontSize: "0.76rem",
                  fontWeight: 800
                }}>
                  +{totalPoints} แต้ม
                </span>
              </div>
              <p style={{ margin: 0, fontSize: "0.82rem", color: "rgba(255,255,255,0.85)", lineHeight: 1.4 }}>
                ความเห็นของคุณช่วยพัฒนาบริการให้ดียิ่งขึ้น พร้อมรับทันที <strong>+{totalPoints} Kiwmee Points</strong> หลังส่งรีวิว
              </p>
            </div>

            {/* 2. Appointment Context Card */}
            <div style={{
              borderRadius: "18px",
              background: "#fff",
              border: "1px solid var(--line-soft)",
              padding: "16px",
              boxShadow: "0 2px 10px rgba(27, 22, 64, 0.03)",
              display: "grid",
              gap: "8px"
            }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span style={{ fontSize: "0.76rem", fontWeight: 700, color: "var(--grape-deep)", background: "var(--selected)", padding: "2px 8px", borderRadius: "8px" }}>
                  Appointment {displayRef}
                </span>
                <span style={{ fontSize: "0.74rem", color: "var(--mint-deep)", fontWeight: 600 }}>
                  ✓ เสร็จสิ้นแล้ว
                </span>
              </div>

              <div>
                <strong style={{ fontSize: "0.96rem", color: "var(--ink)", display: "block" }}>
                  {shop.name}
                </strong>
                <span style={{ fontSize: "0.82rem", color: "var(--muted)" }}>
                  ตัดแต่งทรงผมสไตล์เกาหลี + Olaplex Treatment
                </span>
              </div>

              <div style={{
                display: "flex",
                alignItems: "center",
                gap: "10px",
                borderTop: "1px solid var(--line-soft)",
                paddingTop: "10px",
                marginTop: "2px"
              }}>
                <div style={{
                  width: "36px",
                  height: "36px",
                  borderRadius: "50%",
                  background: "var(--selected)",
                  color: "var(--grape-deep)",
                  display: "grid",
                  placeItems: "center",
                  fontWeight: 700,
                  fontSize: "0.85rem",
                  flex: "none"
                }}>
                  ม
                </div>
                <div>
                  <div style={{ display: "flex", alignItems: "center", gap: "4px" }}>
                    <strong style={{ fontSize: "0.86rem", color: "var(--ink)" }}>ช่างเมย์ (Stylist May)</strong>
                    <span style={{ fontSize: "0.72rem", color: "var(--mint-deep)" }}>✓ Verified</span>
                  </div>
                  <span style={{ fontSize: "0.75rem", color: "var(--muted)" }}>ผู้เชี่ยวชาญเลเยอร์คัทเกาหลี</span>
                </div>
              </div>
            </div>

            {/* 3. Interactive Star Rating Card */}
            <div style={{
              borderRadius: "18px",
              background: "#fff",
              border: "1px solid var(--line-soft)",
              padding: "20px 16px",
              textAlign: "center",
              boxShadow: "0 2px 10px rgba(27, 22, 64, 0.03)",
              display: "grid",
              gap: "12px"
            }}>
              <div>
                <span style={{ fontSize: "0.76rem", fontWeight: 700, color: "var(--muted)", textTransform: "uppercase", letterSpacing: "0.05em" }}>
                  Overall Experience
                </span>
                <h3 style={{ margin: "2px 0 0", fontSize: "1.05rem", fontWeight: 700, color: "var(--ink)" }}>
                  คะแนนความพึงพอใจโดยรวม
                </h3>
              </div>

              {/* 5 Big Gold Stars */}
              <div style={{ display: "flex", justifyContent: "center", gap: "10px", padding: "6px 0" }}>
                {[1, 2, 3, 4, 5].map((star) => (
                  <button
                    key={star}
                    type="button"
                    onClick={() => setRating(star)}
                    style={{
                      background: "none",
                      border: 0,
                      padding: "4px",
                      fontSize: "34px",
                      cursor: "pointer",
                      color: star <= rating ? "#F59E0B" : "#D1D5DB",
                      transform: star <= rating ? "scale(1.08)" : "scale(1)",
                      transition: "transform 0.15s, color 0.15s"
                    }}
                    aria-label={`ให้คะแนน ${star} ดาว`}
                  >
                    ★
                  </button>
                ))}
              </div>

              <div style={{
                background: "var(--selected)",
                color: "var(--grape-deep)",
                padding: "6px 14px",
                borderRadius: "20px",
                fontSize: "0.88rem",
                fontWeight: 700,
                display: "inline-block",
                margin: "0 auto"
              }}>
                {RATING_FEEDBACK[rating]}
              </div>

              {/* Sub-criteria Pills */}
              <div style={{
                display: "grid",
                gap: "8px",
                borderTop: "1px solid var(--line-soft)",
                paddingTop: "12px",
                fontSize: "0.8rem",
                color: "var(--muted)",
                textAlign: "left"
              }}>
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span>ฝีมือและการให้คำปรึกษาของช่าง</span>
                  <strong style={{ color: "var(--ink)" }}>{rating}/5</strong>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span>การบริการและความสุภาพของพนักงาน</span>
                  <strong style={{ color: "var(--ink)" }}>{rating}/5</strong>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span>ความคุ้มค่า บรรยากาศ และความสะอาด</span>
                  <strong style={{ color: "var(--ink)" }}>{rating}/5</strong>
                </div>
              </div>
            </div>

            {/* 4. Impression Chips (Multi-select) */}
            <div style={{
              borderRadius: "18px",
              background: "#fff",
              border: "1px solid var(--line-soft)",
              padding: "16px",
              boxShadow: "0 2px 10px rgba(27, 22, 64, 0.03)",
              display: "grid",
              gap: "10px"
            }}>
              <div>
                <strong style={{ fontSize: "0.92rem", color: "var(--ink)", display: "block" }}>
                  สิ่งที่ประทับใจ (เลือกได้หลายข้อ)
                </strong>
                <span style={{ fontSize: "0.76rem", color: "var(--muted)" }}>แตะเพื่อเลือกจุดเด่นที่ชื่นชอบ</span>
              </div>

              <div style={{ display: "flex", flexWrap: "wrap", gap: "8px" }}>
                {IMPRESSION_CHIPS.map((chip) => {
                  const isChecked = selectedChips.includes(chip);
                  return (
                    <button
                      key={chip}
                      type="button"
                      onClick={() => toggleChip(chip)}
                      style={{
                        padding: "7px 12px",
                        borderRadius: "14px",
                        border: isChecked ? "1.5px solid var(--grape)" : "1px solid var(--line-soft)",
                        background: isChecked ? "var(--selected)" : "var(--bg)",
                        color: isChecked ? "var(--grape-deep)" : "var(--ink)",
                        fontSize: "0.8rem",
                        fontWeight: isChecked ? 700 : 500,
                        cursor: "pointer",
                        transition: "all 0.12s ease"
                      }}
                    >
                      {chip}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* 5. Text Review Textarea */}
            <div style={{
              borderRadius: "18px",
              background: "#fff",
              border: "1px solid var(--line-soft)",
              padding: "16px",
              boxShadow: "0 2px 10px rgba(27, 22, 64, 0.03)",
              display: "grid",
              gap: "8px"
            }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <strong style={{ fontSize: "0.92rem", color: "var(--ink)" }}>
                  เขียนความคิดเห็นของคุณ
                </strong>
                <span style={{ fontSize: "0.74rem", color: "var(--muted)" }}>
                  {comment.length}/500
                </span>
              </div>

              <textarea
                value={comment}
                onChange={(e) => setComment(e.target.value.slice(0, 500))}
                rows={4}
                placeholder="เล่าความประทับใจ เช่น ทรงผมตรงเรฟไหม ช่างแนะนำดีไหม หรือสิ่งที่อยากให้พัฒนาเพิ่มเติม..."
                style={{
                  width: "100%",
                  boxSizing: "border-box",
                  borderRadius: "12px",
                  border: "1px solid var(--line-soft)",
                  padding: "10px 12px",
                  font: "inherit",
                  fontSize: "0.86rem",
                  color: "var(--ink)",
                  resize: "vertical"
                }}
              />
            </div>

            {/* 6. Photo Upload Section */}
            <div style={{
              borderRadius: "18px",
              background: "#fff",
              border: "1px solid var(--line-soft)",
              padding: "16px",
              boxShadow: "0 2px 10px rgba(27, 22, 64, 0.03)",
              display: "grid",
              gap: "10px"
            }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <div>
                  <strong style={{ fontSize: "0.92rem", color: "var(--ink)", display: "block" }}>
                    เพิ่มรูปภาพทรงผมของคุณ
                  </strong>
                  <span style={{ fontSize: "0.74rem", color: "var(--grape-deep)", fontWeight: 600 }}>
                    รับแต้มเพิ่มพิเศษ +20 Points ✨
                  </span>
                </div>
                <span style={{ fontSize: "0.76rem", color: "var(--muted)" }}>
                  {photos.length}/3 รูป
                </span>
              </div>

              <div style={{ display: "flex", gap: "10px" }}>
                {photos.map((photo, i) => (
                  <div
                    key={i}
                    style={{
                      position: "relative",
                      width: "80px",
                      height: "80px",
                      borderRadius: "14px",
                      overflow: "hidden",
                      border: "1px solid var(--line-soft)",
                      flex: "none"
                    }}
                  >
                    <img
                      src={photo.url}
                      alt={`ภาพทรงผม ${i + 1}`}
                      style={{ width: "100%", height: "100%", objectFit: "cover" }}
                    />
                    <button
                      type="button"
                      onClick={() => removePhoto(i)}
                      style={{
                        position: "absolute",
                        top: "4px",
                        right: "4px",
                        width: "20px",
                        height: "20px",
                        borderRadius: "50%",
                        background: "rgba(0,0,0,0.6)",
                        color: "#fff",
                        border: 0,
                        display: "grid",
                        placeItems: "center",
                        fontSize: "12px",
                        cursor: "pointer",
                        padding: 0
                      }}
                      aria-label="ลบรูปภาพ"
                    >
                      ✕
                    </button>
                  </div>
                ))}

                {photos.length < 3 && (
                  <label style={{
                    width: "80px",
                    height: "80px",
                    borderRadius: "14px",
                    border: "1.5px dashed var(--grape)",
                    background: "var(--selected)",
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "center",
                    justifyContent: "center",
                    gap: "4px",
                    cursor: "pointer",
                    color: "var(--grape-deep)",
                    flex: "none"
                  }}>
                    <span style={{ fontSize: "20px" }}>📷</span>
                    <span style={{ fontSize: "0.68rem", fontWeight: 600 }}>เพิ่มรูป</span>
                    <input
                      type="file"
                      accept="image/*"
                      multiple
                      onChange={handlePhotoUpload}
                      style={{ display: "none" }}
                    />
                  </label>
                )}
              </div>
            </div>

            {/* 7. Privacy & Showcase Consents */}
            <div style={{
              borderRadius: "18px",
              background: "#fff",
              border: "1px solid var(--line-soft)",
              padding: "14px 16px",
              display: "grid",
              gap: "10px"
            }}>
              <label style={{ display: "flex", alignItems: "flex-start", gap: "10px", cursor: "pointer" }}>
                <input
                  type="checkbox"
                  checked={consentShowcase}
                  onChange={(e) => setConsentShowcase(e.target.checked)}
                  style={{ marginTop: "3px", accentColor: "var(--grape)" }}
                />
                <span style={{ fontSize: "0.8rem", color: "var(--ink)", lineHeight: 1.4 }}>
                  ยินยอมให้นำรีวิวและภาพไปแสดงในหน้าผลงานร้าน (เพื่อรับสิทธิ์ลุ้นรับ Gift Voucher ฿500 ประจำเดือน Kiwmee Showcase 🎁)
                </span>
              </label>

              <label style={{ display: "flex", alignItems: "center", gap: "10px", cursor: "pointer", borderTop: "1px solid var(--line-soft)", paddingTop: "8px" }}>
                <input
                  type="checkbox"
                  checked={isAnonymous}
                  onChange={(e) => setIsAnonymous(e.target.checked)}
                  style={{ accentColor: "var(--grape)" }}
                />
                <span style={{ fontSize: "0.8rem", color: "var(--muted)" }}>
                  แสดงรีวิวแบบไม่เปิดเผยชื่อ (Anonymous)
                </span>
              </label>
            </div>

            {/* 8. Sticky Bottom Action Bar */}
            <aside style={{
              position: "fixed",
              bottom: 0,
              left: 0,
              right: 0,
              zIndex: 40,
              background: "rgba(255, 255, 255, 0.95)",
              backdropFilter: "blur(12px)",
              borderTop: "1px solid var(--line)",
              padding: "12px 16px",
              boxShadow: "0 -4px 16px rgba(0, 0, 0, 0.05)"
            }}>
              <div style={{ maxWidth: "480px", margin: "0 auto", display: "flex", justifyContent: "space-between", alignItems: "center", gap: "12px" }}>
                <div>
                  <span style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: "4px",
                    background: "var(--selected)",
                    color: "var(--grape-deep)",
                    padding: "3px 8px",
                    borderRadius: "10px",
                    fontSize: "0.78rem",
                    fontWeight: 700
                  }}>
                    ✨ +{totalPoints} แต้ม
                  </span>
                  <span style={{ fontSize: "0.72rem", color: "var(--muted)", display: "block", marginTop: "2px" }}>
                    Gold Member
                  </span>
                </div>

                <div style={{ display: "flex", gap: "8px" }}>
                  <a
                    href={`/b/${shop.slug}/me`}
                    style={{
                      padding: "10px 14px",
                      borderRadius: "12px",
                      background: "var(--bg)",
                      color: "var(--muted)",
                      fontSize: "0.82rem",
                      fontWeight: 600,
                      textDecoration: "none"
                    }}
                  >
                    ข้าม
                  </a>

                  <button
                    type="submit"
                    disabled={isSubmitting}
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: "6px",
                      background: "var(--grape)",
                      color: "#fff",
                      padding: "10px 20px",
                      borderRadius: "14px",
                      fontWeight: 700,
                      fontSize: "0.88rem",
                      border: 0,
                      cursor: "pointer",
                      boxShadow: "0 4px 14px rgba(106, 76, 255, 0.3)"
                    }}
                  >
                    <span>{isSubmitting ? "กำลังส่ง..." : "ส่งรีวิวและรับคะแนน"}</span>
                    <span>✨</span>
                  </button>
                </div>
              </div>
            </aside>
          </form>
        )}
      </main>
    </CustomerFrame>
  );
}

