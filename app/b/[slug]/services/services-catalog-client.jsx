"use client";

import { useState, useMemo } from "react";
import CustomerFrame from "../customer-frame.jsx";
import { CustomerTabs, ShopHero, withMedia } from "../booking-presentation.jsx";
import { useLiff } from "../use-liff.jsx";

const baht = (n) => (n ? `฿${Number(n).toLocaleString("th-TH")}` : "ติดต่อสอบถาม");

const CATEGORY_ICONS = {
  "ตัด": "✂️",
  "ตัดผม": "✂️",
  "ทรงผม": "✂️",
  "ทำสี": "🎨",
  "สีผม": "🎨",
  "ดัด": "🌀",
  "ยืด": "✨",
  "ทรีตเมนต์": "💆‍♀️",
  "สปา": "🧖‍♀️",
  "เล็บ": "💅",
  "ต่อขนตา": "👁️",
  "นวด": "🌿"
};

function getCategoryIcon(catName = "") {
  for (const [key, icon] of Object.entries(CATEGORY_ICONS)) {
    if (catName.includes(key)) return icon;
  }
  return "✨";
}

// Fallback rich catalog presets when shop has basic services
const DEMO_ENHANCEMENTS = {
  cut: {
    enTitle: "Korean Layered Cut & Organic Wash",
    desc: "ดีไซน์ทรงผมเลเยอร์เกาหลีให้รับกับรูปหน้า สระไดร์ผ่อนคลายด้วยแชมพูออร์แกนิก",
    badge: "Best Seller"
  },
  colour: {
    enTitle: "Milbon Premium Organic Color",
    desc: "ทำสีผมนำเข้าจากญี่ปุ่น สีติดทนนาน ประกายเงางาม พร้อมบำรุงลึก ป้องกันผมแห้งเสีย",
    badge: "ยอดนิยม"
  },
  treatment: {
    enTitle: "Olaplex Deep Rebuilding Spa",
    desc: "ทรีตเมนต์ฟื้นฟูโครงสร้างแกนผมลึกระดับพันธะไดซัลไฟด์ ผมนุ่มมีน้ำหนัก สุขภาพดีทันที",
    badge: "แนะนำ"
  }
};

export default function ServicesCatalogClient({ shop, liffId }) {
  const liff = useLiff(liffId);
  const [activeCategory, setActiveCategory] = useState("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedService, setSelectedService] = useState(null);
  const [toast, setToast] = useState(null);

  const offerings = useMemo(() => shop.offerings || [], [shop.offerings]);

  // Extract categories dynamically
  const categories = useMemo(() => {
    const raw = offerings.map((o) => o.category).filter(Boolean);
    const unique = [...new Set(raw)];
    if (unique.length === 0) {
      return ["ตัดแต่งทรงผม", "ทรีตเมนต์ & สปา", "ทำสี & ดัดลอน"];
    }
    return unique;
  }, [offerings]);

  // Filter offerings by category and search
  const filteredOfferings = useMemo(() => {
    return offerings.filter((o) => {
      const matchCat = activeCategory === "all" || o.category === activeCategory;
      const matchQuery =
        !searchQuery.trim() ||
        o.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
        (o.category && o.category.toLowerCase().includes(searchQuery.toLowerCase())) ||
        (o.description && o.description.toLowerCase().includes(searchQuery.toLowerCase()));
      return matchCat && matchQuery;
    });
  }, [offerings, activeCategory, searchQuery]);

  // Group filtered offerings by category
  const groupedOfferings = useMemo(() => {
    const groups = {};
    for (const o of filteredOfferings) {
      const cat = o.category || "บริการยอดนิยม";
      if (!groups[cat]) groups[cat] = [];
      groups[cat].push(o);
    }
    return groups;
  }, [filteredOfferings]);

  const showToast = (msg) => {
    setToast(msg);
    setTimeout(() => setToast(null), 3000);
  };

  const handleShare = async () => {
    const shareData = {
      title: `บริการและราคา · ${shop.name}`,
      text: `ดูเมนูบริการและราคาพร้อมจองคิวออนไลน์ที่ ${shop.name}`,
      url: window.location.href
    };
    if (navigator.share) {
      try {
        await navigator.share(shareData);
      } catch {
        // user cancelled share
      }
    } else {
      navigator.clipboard?.writeText(window.location.href);
      showToast("คัดลอกลิงก์บริการเรียบร้อยแล้ว");
    }
  };

  return (
    <CustomerFrame>
      <main className="bk-shell bk-with-tabs" style={{ paddingBottom: "120px" }}>
        {/* Top Header Bar */}
        <header className="bk-topbar" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "8px" }}>
          <a href={`/b/${shop.slug}`} className="bk-icon-btn" aria-label="กลับหน้าจองคิว">
            <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
              <path d="M15 18l-6-6 6-6" />
            </svg>
          </a>
          <div style={{ textAlign: "center" }}>
            <span style={{ fontSize: "0.76rem", fontWeight: 700, color: "var(--grape-deep)", letterSpacing: "0.06em", textTransform: "uppercase" }}>
              Services Catalog
            </span>
            <h1 style={{ margin: 0, fontSize: "1.1rem", fontWeight: 700, color: "var(--ink)" }}>
              บริการและราคา
            </h1>
          </div>
          <button type="button" className="bk-icon-btn" onClick={handleShare} aria-label="แชร์บริการ">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="18" cy="5" r="3" />
              <circle cx="6" cy="12" r="3" />
              <circle cx="18" cy="19" r="3" />
              <line x1="8.59" y1="13.51" x2="15.42" y2="17.49" />
              <line x1="15.41" y1="6.51" x2="8.59" y2="10.49" />
            </svg>
          </button>
        </header>

        {/* Shop Cover & Identity */}
        <ShopHero shop={shop} />

        {/* Live Search & Filter Bar */}
        <div style={{ position: "relative", marginTop: "12px", marginBottom: "10px" }}>
          <svg style={{ position: "absolute", left: "14px", top: "50%", transform: "translateY(-50%)", color: "var(--muted)", pointerEvents: "none" }} viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input
            type="search"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="ค้นหาบริการ เช่น ตัดผม, ทรีตเมนต์, ดัดลอน..."
            style={{
              width: "100%",
              boxSizing: "border-box",
              padding: "12px 38px 12px 42px",
              borderRadius: "16px",
              border: "1.5px solid var(--line-soft)",
              background: "#fff",
              font: "inherit",
              fontSize: "0.92rem",
              color: "var(--ink)",
              boxShadow: "0 2px 8px rgba(27, 22, 64, 0.04)"
            }}
          />
          {searchQuery && (
            <button
              type="button"
              onClick={() => setSearchQuery("")}
              style={{
                position: "absolute",
                right: "12px",
                top: "50%",
                transform: "translateY(-50%)",
                background: "var(--bg)",
                border: 0,
                borderRadius: "50%",
                width: "22px",
                height: "22px",
                display: "grid",
                placeItems: "center",
                color: "var(--muted)",
                cursor: "pointer",
                padding: 0
              }}
              aria-label="ล้างการค้นหา"
            >
              ✕
            </button>
          )}
        </div>

        {/* Trust Notice Banner */}
        <div style={{
          display: "flex",
          alignItems: "center",
          gap: "8px",
          padding: "10px 14px",
          borderRadius: "14px",
          background: "linear-gradient(90deg, #F7F5FF 0%, #ECFDF5 100%)",
          border: "1px solid var(--line-soft)",
          marginBottom: "14px"
        }}>
          <span style={{ fontSize: "16px" }}>⚡</span>
          <span style={{ fontSize: "0.8rem", color: "var(--ink)", fontWeight: 500, lineHeight: 1.35 }}>
            <strong>จองง่ายผ่าน LINE OA</strong> • เลื่อน/ยกเลิกฟรีล่วงหน้า 2 ชม. คืนมัดจำ 100%
          </span>
        </div>

        {/* Category Horizontal Filter Chips */}
        <div style={{
          display: "flex",
          gap: "8px",
          overflowX: "auto",
          paddingBottom: "8px",
          marginBottom: "16px",
          scrollbarWidth: "none"
        }}>
          <button
            type="button"
            onClick={() => setActiveCategory("all")}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "6px",
              padding: "8px 14px",
              borderRadius: "20px",
              border: activeCategory === "all" ? "1.5px solid var(--grape)" : "1px solid var(--line-soft)",
              background: activeCategory === "all" ? "var(--grape)" : "#fff",
              color: activeCategory === "all" ? "#fff" : "var(--ink)",
              fontSize: "0.85rem",
              fontWeight: 600,
              cursor: "pointer",
              whiteSpace: "nowrap",
              transition: "all 0.15s ease"
            }}
          >
            <span>ทั้งหมด (All)</span>
            <span style={{
              background: activeCategory === "all" ? "rgba(255,255,255,0.25)" : "var(--bg)",
              padding: "1px 7px",
              borderRadius: "10px",
              fontSize: "0.72rem"
            }}>
              {offerings.length}
            </span>
          </button>

          {categories.map((cat) => {
            const count = offerings.filter((o) => o.category === cat).length;
            const isCurrent = activeCategory === cat;
            return (
              <button
                key={cat}
                type="button"
                onClick={() => setActiveCategory(cat)}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "6px",
                  padding: "8px 14px",
                  borderRadius: "20px",
                  border: isCurrent ? "1.5px solid var(--grape)" : "1px solid var(--line-soft)",
                  background: isCurrent ? "var(--grape)" : "#fff",
                  color: isCurrent ? "#fff" : "var(--ink)",
                  fontSize: "0.85rem",
                  fontWeight: 600,
                  cursor: "pointer",
                  whiteSpace: "nowrap",
                  transition: "all 0.15s ease"
                }}
              >
                <span>{getCategoryIcon(cat)} {cat}</span>
                {count > 0 && (
                  <span style={{
                    background: isCurrent ? "rgba(255,255,255,0.25)" : "var(--bg)",
                    padding: "1px 6px",
                    borderRadius: "10px",
                    fontSize: "0.72rem"
                  }}>
                    {count}
                  </span>
                )}
              </button>
            );
          })}
        </div>

        {/* Featured Monthly Combo Highlight Card */}
        {activeCategory === "all" && !searchQuery && (
          <div style={{
            position: "relative",
            overflow: "hidden",
            borderRadius: "22px",
            background: "linear-gradient(135deg, #1B1640 0%, #2D2468 100%)",
            color: "#fff",
            padding: "20px",
            marginBottom: "20px",
            boxShadow: "0 10px 28px rgba(27, 22, 64, 0.18)"
          }}>
            <div style={{ position: "absolute", right: "-15px", top: "-15px", width: "90px", height: "90px", borderRadius: "50%", background: "rgba(106, 76, 255, 0.25)", pointerEvents: "none" }} />
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "8px", marginBottom: "8px" }}>
              <span style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "4px",
                background: "linear-gradient(90deg, #6A4CFF 0%, #3DDC97 100%)",
                padding: "3px 10px",
                borderRadius: "12px",
                fontSize: "0.74rem",
                fontWeight: 700,
                color: "#fff",
                textTransform: "uppercase"
              }}>
                ✨ Combo ประจำเดือน
              </span>
              <span style={{
                background: "rgba(61, 220, 151, 0.2)",
                color: "#3DDC97",
                border: "1px solid rgba(61, 220, 151, 0.4)",
                padding: "2px 8px",
                borderRadius: "8px",
                fontSize: "0.72rem",
                fontWeight: 700
              }}>
                ประหยัด ฿100
              </span>
            </div>

            <h3 style={{ margin: "4px 0", fontSize: "1.15rem", fontWeight: 700, color: "#fff" }}>
              ตัดเกาหลี + Olaplex Treatment
            </h3>
            <p style={{ margin: "0 0 14px", fontSize: "0.82rem", color: "rgba(255,255,255,0.75)", lineHeight: 1.4 }}>
              เซ็ตสุดฮิตฟื้นบำรุงล้ำลึก สวยจบใน 90 นาที ดูแลทั้งทรงผมและฟื้นฟูสุขภาพเส้นผม
            </p>

            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", borderTop: "1px solid rgba(255,255,255,0.12)", paddingTop: "12px" }}>
              <div>
                <div style={{ display: "flex", alignItems: "baseline", gap: "8px" }}>
                  <span style={{ fontSize: "1.3rem", fontWeight: 800, color: "#3DDC97" }}>฿1,850</span>
                  <span style={{ fontSize: "0.85rem", color: "rgba(255,255,255,0.45)", textDecoration: "line-through" }}>฿1,950</span>
                </div>
                <div style={{ display: "flex", gap: "8px", marginTop: "4px" }}>
                  <span style={{ fontSize: "0.74rem", color: "rgba(255,255,255,0.7)" }}>⏱️ 90 นาที</span>
                  <span style={{ fontSize: "0.74rem", color: "rgba(255,255,255,0.7)" }}>🔒 มัดจำ ฿300</span>
                </div>
              </div>

              <a
                href={`/b/${shop.slug}`}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "6px",
                  background: "#3DDC97",
                  color: "#065F46",
                  padding: "10px 18px",
                  borderRadius: "14px",
                  fontWeight: 700,
                  fontSize: "0.88rem",
                  textDecoration: "none",
                  boxShadow: "0 4px 12px rgba(61, 220, 151, 0.3)"
                }}
              >
                <span>จองคอมโบนี้</span>
                <span>→</span>
              </a>
            </div>
          </div>
        )}

        {/* Grouped Services List */}
        {Object.keys(groupedOfferings).length === 0 ? (
          <div style={{ textAlign: "center", padding: "40px 20px", background: "#fff", borderRadius: "20px", border: "1px dashed var(--line)" }}>
            <span style={{ fontSize: "36px", display: "block", marginBottom: "8px" }}>🔍</span>
            <p style={{ margin: 0, fontWeight: 600, color: "var(--ink)" }}>ไม่พบบริการที่ตรงกับ "{searchQuery}"</p>
            <p style={{ margin: "4px 0 0", fontSize: "0.85rem", color: "var(--muted)" }}>ลองค้นหาด้วยคำอื่น หรือเลือกดูบริการทั้งหมด</p>
            <button
              type="button"
              onClick={() => { setSearchQuery(""); setActiveCategory("all"); }}
              style={{
                marginTop: "14px",
                padding: "8px 18px",
                borderRadius: "12px",
                border: "1px solid var(--grape)",
                background: "var(--selected)",
                color: "var(--grape-deep)",
                fontWeight: 600,
                cursor: "pointer"
              }}
            >
              ดูบริการทั้งหมด
            </button>
          </div>
        ) : (
          <div style={{ display: "grid", gap: "24px" }}>
            {Object.entries(groupedOfferings).map(([catName, items]) => (
              <section key={catName} style={{ display: "grid", gap: "12px" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <h2 style={{ margin: 0, fontSize: "1.02rem", fontWeight: 700, color: "var(--ink)", display: "flex", alignItems: "center", gap: "6px" }}>
                    <span>{getCategoryIcon(catName)}</span>
                    <span>{catName}</span>
                  </h2>
                  <span style={{ fontSize: "0.78rem", color: "var(--muted)", fontWeight: 500 }}>
                    {items.length} รายการ
                  </span>
                </div>

                <div style={{ display: "grid", gap: "10px" }}>
                  {items.map((offering) => {
                    const demo = DEMO_ENHANCEMENTS[offering.id] || {};
                    const isSelected = selectedService?.id === offering.id;
                    const durationText = offering.duration_minutes ? `${offering.duration_minutes} นาที` : "60 นาที";
                    const depositText = offering.deposit_amount ? `มัดจำ ฿${offering.deposit_amount}` : "มัดจำ ฿300";

                    return (
                      <article
                        key={offering.id}
                        onClick={() => setSelectedService(offering)}
                        style={{
                          borderRadius: "18px",
                          background: "#fff",
                          border: isSelected ? "2px solid var(--grape)" : "1px solid var(--line-soft)",
                          padding: "16px",
                          display: "grid",
                          gap: "8px",
                          boxShadow: isSelected ? "0 4px 18px rgba(106, 76, 255, 0.12)" : "0 2px 10px rgba(27, 22, 64, 0.03)",
                          cursor: "pointer",
                          transition: "all 0.15s ease"
                        }}
                      >
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "10px" }}>
                          <div>
                            {demo.badge && (
                              <span style={{
                                display: "inline-block",
                                background: "var(--selected)",
                                color: "var(--grape-deep)",
                                padding: "2px 8px",
                                borderRadius: "8px",
                                fontSize: "0.72rem",
                                fontWeight: 700,
                                marginBottom: "4px"
                              }}>
                                ★ {demo.badge}
                              </span>
                            )}
                            <h3 style={{ margin: 0, fontSize: "0.98rem", fontWeight: 700, color: "var(--ink)", lineHeight: 1.3 }}>
                              {offering.name}
                            </h3>
                            {demo.enTitle && (
                              <span style={{ fontSize: "0.76rem", color: "var(--muted)", display: "block", marginTop: "1px" }}>
                                {demo.enTitle}
                              </span>
                            )}
                          </div>

                          <div style={{ textAlign: "right", flex: "none" }}>
                            <div style={{ fontSize: "1.08rem", fontWeight: 800, color: "var(--grape-deep)" }}>
                              {baht(offering.price || (offering.duration_minutes ? offering.duration_minutes * 10 : 600))}
                            </div>
                          </div>
                        </div>

                        <p style={{ margin: 0, fontSize: "0.82rem", color: "var(--muted)", lineHeight: 1.4 }}>
                          {offering.description || demo.desc || "บริการคุณภาพพรีเมียมโดยช่างผู้เชี่ยวชาญ ดูแลอย่างพิถีพิถัน"}
                        </p>

                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", borderTop: "1px solid var(--line-soft)", paddingTop: "10px", marginTop: "2px" }}>
                          <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
                            <span style={{
                              display: "inline-flex",
                              alignItems: "center",
                              gap: "4px",
                              fontSize: "0.74rem",
                              color: "var(--muted)",
                              background: "var(--bg)",
                              padding: "3px 8px",
                              borderRadius: "8px"
                            }}>
                              ⏱️ {durationText}
                            </span>
                            <span style={{
                              display: "inline-flex",
                              alignItems: "center",
                              gap: "4px",
                              fontSize: "0.74rem",
                              color: "var(--grape-deep)",
                              background: "var(--selected)",
                              padding: "3px 8px",
                              borderRadius: "8px",
                              fontWeight: 600
                            }}>
                              🔒 {depositText}
                            </span>
                          </div>

                          <a
                            href={`/b/${shop.slug}?offeringId=${offering.id}`}
                            onClick={(e) => e.stopPropagation()}
                            style={{
                              display: "inline-flex",
                              alignItems: "center",
                              gap: "4px",
                              padding: "7px 14px",
                              borderRadius: "12px",
                              background: "var(--grape)",
                              color: "#fff",
                              fontSize: "0.82rem",
                              fontWeight: 600,
                              textDecoration: "none",
                              boxShadow: "0 2px 8px rgba(106, 76, 255, 0.25)"
                            }}
                          >
                            <span>จองบริการนี้</span>
                            <span style={{ fontSize: "12px" }}>→</span>
                          </a>
                        </div>
                      </article>
                    );
                  })}
                </div>
              </section>
            ))}
          </div>
        )}

        {/* Policy & Guide Advice Box */}
        <section style={{
          marginTop: "28px",
          borderRadius: "20px",
          background: "linear-gradient(180deg, #F7F5FF 0%, #FFFFFF 100%)",
          border: "1px solid var(--line)",
          padding: "18px",
          display: "grid",
          gap: "10px"
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <span style={{ fontSize: "18px" }}>ℹ️</span>
            <strong style={{ fontSize: "0.92rem", color: "var(--ink)" }}>คำแนะนำสำหรับการจองคิวออนไลน์</strong>
          </div>
          <ul style={{ margin: 0, paddingLeft: "20px", fontSize: "0.8rem", color: "var(--muted)", lineHeight: 1.6, display: "grid", gap: "4px" }}>
            <li>ยอดมัดจำจะถูกนำไปหักเต็มจำนวนจากยอดบิลจริงในวันเข้ารับบริการ</li>
            <li>สามารถเปลี่ยนช่างผู้เชี่ยวชาญหรือเพิ่มบริการเสริมได้ในขั้นตอนถัดไป</li>
            <li>เลื่อนหรือยกเลิกคิวได้ฟรีล่วงหน้าอย่างน้อย 2 ชั่วโมง คืนเงินมัดจำ 100% ทันที</li>
            <li>รับคะแนนสะสม Kiwmee Points ทันทีหลังรับบริการเพื่อแลกสิทธิพิเศษและส่วนลด</li>
          </ul>
        </section>

        {/* Sticky Bottom Booking Bar */}
        <aside style={{
          position: "fixed",
          bottom: "64px",
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
              <span style={{ fontSize: "0.74rem", color: "var(--muted)", display: "block" }}>
                {selectedService ? "บริการที่สนใจ" : "ยังไม่ได้เลือกบริการ"}
              </span>
              <strong style={{ fontSize: "0.95rem", color: "var(--ink)" }}>
                {selectedService ? selectedService.name : "ดูคิวว่างทั้งหมด"}
              </strong>
            </div>

            <a
              href={selectedService ? `/b/${shop.slug}?offeringId=${selectedService.id}` : `/b/${shop.slug}`}
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
                textDecoration: "none",
                boxShadow: "0 4px 14px rgba(106, 76, 255, 0.3)"
              }}
            >
              <span>{selectedService ? "ไปเลือกช่างและเวลา" : "ไปหน้าจองคิว (Step 1)"}</span>
              <span>→</span>
            </a>
          </div>
        </aside>

        {/* Toast Notification */}
        {toast && (
          <div style={{
            position: "fixed",
            top: "20px",
            left: "50%",
            transform: "translateX(-50%)",
            background: "#1B1640",
            color: "#fff",
            padding: "10px 20px",
            borderRadius: "30px",
            fontSize: "0.85rem",
            fontWeight: 600,
            zIndex: 9999,
            boxShadow: "0 6px 20px rgba(0,0,0,0.2)"
          }}>
            {toast}
          </div>
        )}
      </main>

      <CustomerTabs slug={shop.slug} active="services" />
    </CustomerFrame>
  );
}
