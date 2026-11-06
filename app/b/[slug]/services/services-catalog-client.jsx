"use client";

import { useState, useMemo } from "react";
import CustomerFrame from "../customer-frame.jsx";
import { useLiff } from "../use-liff.jsx";

const baht = (n) => (n != null ? `฿${Number(n).toLocaleString("th-TH")}` : "ติดต่อสอบถาม");

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
  "นวด": "🌿",
  "กีฬา": "🏸",
  "สนาม": "🏟️"
};

function getCategoryIcon(catName = "") {
  for (const [key, icon] of Object.entries(CATEGORY_ICONS)) {
    if (catName.includes(key)) return icon;
  }
  return "✨";
}

const DEFAULT_IMAGES = {
  cut: "https://lh3.googleusercontent.com/aida-public/AB6AXuDtIVrHXetT_zM7qjeYqc7WryD7z0h82x4FFuIheBTJzEbJe36EckmbxOiH6nkU8M3iQjUvY9pkC__9wWcwDWVxfKWUwsZ78F3ZbYoP7cgUgt9mXCA6RXtm2OtA9Jj0KvHKOvRIqiV8M9dk_NH8zrizZqo1rzpztxZe21ONJrxl0kE1g0fKgdBFWH-gBYWraKL_gVayLemEm1w71O0VasOjAMbOF5Q85JreNv7wJLpN",
  treatment: "https://lh3.googleusercontent.com/aida-public/AB6AXuANYycUZkZv67QhvahMviZilkkytPacHHpHqv48ciKaBc-vtjYXa3qN9ZQg8AFKi1S_IiaNLmgISlQSQ6LUSB0Jqkim4WgmHaMh6gQLRX8nLDaGV6o0jcVR2u19aSWjjnb5oXydeuuP9YeMa1CtlQt-Wiz4YMIpWlxm68O5j3H3Pl0LpnelPvV8V-5JSwi2KMmzT6JR5nf8v65SRxeU6Wxx_MUsItpWnfaV2qZ3gI6_",
  color: "https://lh3.googleusercontent.com/aida-public/AB6AXuA9AxcY22IZ4qiFeV9C8slKOEgYnY6nQMsNpsf_7M47qQh-HR8E5uu4a9pQp9FBFIh6CQdoLImqTZqkmnKZsMnij0YcEZyUPHqV46YbcXAL5mG1dvMH4lR814AK2OlFpwiDEhavjhdI6ru9eXXCng_eaTqUMPEXFSejIBjFbCPmOIOEDKYP-uPASA2AzKzPbiVAFLxRjAb5_rs5o-ZcoANXCicO_wgAjdaGidS_SCrc",
  nail: "https://lh3.googleusercontent.com/aida-public/AB6AXuBTZVaphzNDt2k0zEkFSGAEDS4q8IpwgoktnVTd08ur_zEoHAppPA2W4poZLINXPaSSu47zlLDXgKZIKky17ucbhadbFrW6ex4uzZH6YVh4evb4QrWF_GMzwwtyyGEf_O59tCS1DObEmALcfCDaGw4ndGlIQlxKsHkN6loD1NnksIoK2fpCHEdaPfWYa-tZ_kfsKRT9KLETUc6Qc83sSQW5xfdZ0RS2JeAWxCfqwsnD",
  default: "https://lh3.googleusercontent.com/aida-public/AB6AXuDtIVrHXetT_zM7qjeYqc7WryD7z0h82x4FFuIheBTJzEbJe36EckmbxOiH6nkU8M3iQjUvY9pkC__9wWcwDWVxfKWUwsZ78F3ZbYoP7cgUgt9mXCA6RXtm2OtA9Jj0KvHKOvRIqiV8M9dk_NH8zrizZqo1rzpztxZe21ONJrxl0kE1g0fKgdBFWH-gBYWraKL_gVayLemEm1w71O0VasOjAMbOF5Q85JreNv7wJLpN"
};

function getServiceImage(offering) {
  if (offering?.media?.[0]?.url) return offering.media[0].url;
  const name = (offering?.name || "").toLowerCase();
  const cat = (offering?.category || "").toLowerCase();
  if (name.includes("สี") || cat.includes("สี")) return DEFAULT_IMAGES.color;
  if (name.includes("ทรีต") || name.includes("สปา") || cat.includes("ทรีต") || cat.includes("สปา")) return DEFAULT_IMAGES.treatment;
  if (name.includes("เล็บ") || cat.includes("เล็บ")) return DEFAULT_IMAGES.nail;
  return DEFAULT_IMAGES.cut;
}

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
      const cat = o.category || "บริการแนะนำ";
      if (!groups[cat]) groups[cat] = [];
      groups[cat].push(o);
    }
    return groups;
  }, [filteredOfferings]);

  const showToast = (msg) => {
    setToast(msg);
    setTimeout(() => setToast(null), 2500);
  };

  const handleShare = async () => {
    const shareData = {
      title: `บริการและราคา · ${shop.name}`,
      text: `ดูเมนูบริการและราคามาตรฐานของ ${shop.name} พร้อมจองคิวออนไลน์ผ่าน LINE`,
      url: window.location.href
    };
    if (navigator.share) {
      try {
        await navigator.share(shareData);
      } catch {}
    } else {
      navigator.clipboard?.writeText(window.location.href);
      showToast("คัดลอกลิงก์บริการเรียบร้อยแล้ว ✨");
    }
  };

  const toggleSelect = (offering, e) => {
    e?.stopPropagation();
    if (selectedService?.id === offering.id) {
      setSelectedService(null);
      showToast("ยกเลิกการเลือกบริการแล้ว");
    } else {
      setSelectedService(offering);
      showToast(`เลือก "${offering.name}" เรียบร้อยแล้ว`);
    }
  };

  const priceAmount = selectedService?.price?.amount ?? 0;
  const depositAmount = priceAmount > 0 ? Math.min(300, Math.round(priceAmount * 0.3)) : 0;

  return (
    <CustomerFrame>
      <div style={{ minHeight: "100vh", background: "var(--surface)", display: "flex", flexDirection: "column" }}>
        {/* Sticky App Header (Stitch Screen 10) */}
        <header style={{
          position: "sticky",
          top: 0,
          zIndex: 40,
          background: "rgba(252, 248, 255, 0.92)",
          backdropFilter: "blur(16px)",
          borderBottom: "1px solid var(--line-soft)",
          padding: "10px 16px",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "8px"
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: "8px", minWidth: 0 }}>
            <a
              href={`/b/${shop.slug}`}
              style={{
                width: "38px",
                height: "38px",
                borderRadius: "50%",
                display: "grid",
                placeItems: "center",
                color: "var(--ink)",
                textDecoration: "none",
                background: "var(--surface-container-low)"
              }}
              aria-label="ย้อนกลับ"
            >
              <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                <path d="M15 18l-6-6 6-6" />
              </svg>
            </a>
            <div style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
              <span style={{ fontSize: "0.72rem", color: "var(--grape-deep)", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", lineHeight: 1.2 }}>
                {shop.name}
              </span>
              <h1 style={{ margin: 0, fontSize: "1.05rem", fontWeight: 700, color: "var(--ink)", lineHeight: 1.3 }}>
                บริการและราคา
              </h1>
            </div>
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: "6px", flexShrink: 0 }}>
            <button
              type="button"
              onClick={handleShare}
              style={{
                width: "36px",
                height: "36px",
                borderRadius: "50%",
                border: 0,
                background: "var(--surface-container-low)",
                color: "var(--ink)",
                display: "grid",
                placeItems: "center",
                cursor: "pointer"
              }}
              aria-label="แชร์บริการ"
            >
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="18" cy="5" r="3" />
                <circle cx="6" cy="12" r="3" />
                <circle cx="18" cy="19" r="3" />
                <line x1="8.59" y1="13.51" x2="15.42" y2="17.49" />
                <line x1="15.41" y1="6.51" x2="8.59" y2="10.49" />
              </svg>
            </button>
            <a
              href={`/b/${shop.slug}/me`}
              style={{
                width: "36px",
                height: "36px",
                borderRadius: "50%",
                background: "var(--grape-deep)",
                color: "#fff",
                display: "grid",
                placeItems: "center",
                textDecoration: "none"
              }}
              aria-label="การจองของฉัน"
            >
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
                <circle cx="12" cy="7" r="4" />
              </svg>
            </a>
          </div>
        </header>

        {/* Main Content Area */}
        <main style={{ flex: 1, padding: "12px 16px", paddingBottom: "100px", maxWidth: "480px", margin: "0 auto", width: "100%", boxSizing: "border-box" }}>
          {/* Search Input */}
          <div style={{ position: "relative", marginBottom: "10px" }}>
            <span style={{ position: "absolute", left: "14px", top: "50%", transform: "translateY(-50%)", color: "var(--muted)", pointerEvents: "none", fontSize: "16px" }}>
              🔍
            </span>
            <input
              type="search"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="ค้นหาบริการ เช่น ตัดผม, ทรีตเมนต์, ดัดลอน..."
              style={{
                width: "100%",
                boxSizing: "border-box",
                padding: "11px 36px 11px 40px",
                borderRadius: "14px",
                border: "1px solid var(--line-soft)",
                background: "#fff",
                font: "inherit",
                fontSize: "0.9rem",
                color: "var(--ink)",
                boxShadow: "0 2px 6px rgba(27, 22, 64, 0.03)"
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
                  width: "20px",
                  height: "20px",
                  display: "grid",
                  placeItems: "center",
                  color: "var(--muted)",
                  cursor: "pointer",
                  padding: 0,
                  fontSize: "12px"
                }}
              >
                ✕
              </button>
            )}
          </div>

          {/* Trust Policy Micro Banner */}
          <div style={{
            display: "flex",
            alignItems: "center",
            gap: "8px",
            padding: "8px 12px",
            borderRadius: "12px",
            background: "linear-gradient(90deg, #F6F2FF 0%, #ECFDF5 100%)",
            border: "1px solid var(--line-soft)",
            marginBottom: "12px"
          }}>
            <span style={{ fontSize: "16px" }}>⚡</span>
            <p style={{ margin: 0, fontSize: "0.78rem", color: "var(--ink)", fontWeight: 500, lineHeight: 1.35 }}>
              <strong>จองง่ายผ่าน LINE OA</strong> • เลื่อน/ยกเลิกฟรีล่วงหน้า 2 ชม. คืนมัดจำ 100%
            </p>
          </div>

          {/* Category Horizontal Filter Chips */}
          <div style={{
            display: "flex",
            gap: "8px",
            overflowX: "auto",
            paddingBottom: "6px",
            marginBottom: "14px",
            scrollbarWidth: "none"
          }}>
            <button
              type="button"
              onClick={() => setActiveCategory("all")}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "6px",
                padding: "7px 14px",
                borderRadius: "999px",
                border: activeCategory === "all" ? "1.5px solid var(--grape-deep)" : "1px solid var(--line-soft)",
                background: activeCategory === "all" ? "var(--grape-deep)" : "#fff",
                color: activeCategory === "all" ? "#fff" : "var(--ink)",
                fontSize: "0.82rem",
                fontWeight: 600,
                cursor: "pointer",
                whiteSpace: "nowrap",
                flexShrink: 0,
                boxShadow: activeCategory === "all" ? "0 2px 8px rgba(106, 76, 255, 0.25)" : "none"
              }}
            >
              <span>ทั้งหมด (All)</span>
              <span style={{
                background: activeCategory === "all" ? "rgba(255,255,255,0.25)" : "var(--bg)",
                padding: "1px 6px",
                borderRadius: "10px",
                fontSize: "0.7rem"
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
                    padding: "7px 14px",
                    borderRadius: "999px",
                    border: isCurrent ? "1.5px solid var(--grape-deep)" : "1px solid var(--line-soft)",
                    background: isCurrent ? "var(--grape-deep)" : "#fff",
                    color: isCurrent ? "#fff" : "var(--ink)",
                    fontSize: "0.82rem",
                    fontWeight: 600,
                    cursor: "pointer",
                    whiteSpace: "nowrap",
                    flexShrink: 0,
                    boxShadow: isCurrent ? "0 2px 8px rgba(106, 76, 255, 0.25)" : "none"
                  }}
                >
                  <span>{getCategoryIcon(cat)} {cat}</span>
                  {count > 0 && (
                    <span style={{
                      background: isCurrent ? "rgba(255,255,255,0.25)" : "var(--bg)",
                      padding: "1px 6px",
                      borderRadius: "10px",
                      fontSize: "0.7rem"
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
              borderRadius: "20px",
              background: "linear-gradient(135deg, #512ae6 0%, #6a4cff 60%, #7d4de7 100%)",
              color: "#fff",
              padding: "18px",
              marginBottom: "18px",
              boxShadow: "0 8px 24px rgba(106, 76, 255, 0.25)"
            }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "8px", marginBottom: "6px" }}>
                <span style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "4px",
                  background: "#65fdb5",
                  color: "#00734a",
                  padding: "3px 10px",
                  borderRadius: "999px",
                  fontSize: "0.72rem",
                  fontWeight: 700
                }}>
                  ⭐ Combo ประจำเดือน
                </span>
                <div style={{ textAlign: "right" }}>
                  <span style={{ fontSize: "0.78rem", color: "#c8bfff", textDecoration: "line-through", display: "block" }}>฿1,950</span>
                  <span style={{ fontSize: "1.3rem", fontWeight: 800, color: "#65fdb5", lineHeight: 1 }}>฿1,850</span>
                </div>
              </div>

              <h2 style={{ margin: "2px 0 4px", fontSize: "1.1rem", fontWeight: 700, color: "#fff" }}>
                ตัดเกาหลี + Olaplex Treatment
              </h2>
              <p style={{ margin: "0 0 12px", fontSize: "0.8rem", color: "rgba(255,255,255,0.85)", lineHeight: 1.4 }}>
                เซ็ตสุดฮิตฟื้นบำรุงล้ำลึก สวยจบใน 90 นาที
              </p>

              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", borderTop: "1px solid rgba(255,255,255,0.18)", paddingTop: "10px" }}>
                <div style={{ display: "flex", gap: "10px", fontSize: "0.74rem", color: "rgba(255,255,255,0.85)" }}>
                  <span>⏱ 90 นาที</span>
                  <span>🔒 มัดจำ ฿400</span>
                </div>

                <a
                  href={`/b/${shop.slug}`}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: "4px",
                    background: "#65fdb5",
                    color: "#00734a",
                    padding: "7px 14px",
                    borderRadius: "12px",
                    fontWeight: 700,
                    fontSize: "0.82rem",
                    textDecoration: "none",
                    boxShadow: "0 2px 8px rgba(101, 253, 181, 0.4)"
                  }}
                >
                  <span>+ จองคอมโบนี้</span>
                </a>
              </div>
            </div>
          )}

          {/* Services List by Category */}
          {Object.keys(groupedOfferings).length === 0 ? (
            <div style={{ textAlign: "center", padding: "36px 16px", background: "#fff", borderRadius: "18px", border: "1px dashed var(--line)" }}>
              <span style={{ fontSize: "32px", display: "block", marginBottom: "6px" }}>🔍</span>
              <p style={{ margin: 0, fontWeight: 700, color: "var(--ink)" }}>ไม่พบบริการที่คุณค้นหา</p>
              <p style={{ margin: "4px 0 14px", fontSize: "0.82rem", color: "var(--muted)" }}>ลองค้นหาด้วยคำอื่น หรือเลือกดูบริการทั้งหมด</p>
              <button
                type="button"
                onClick={() => { setSearchQuery(""); setActiveCategory("all"); }}
                style={{
                  padding: "8px 18px",
                  borderRadius: "12px",
                  border: 0,
                  background: "var(--grape-deep)",
                  color: "#fff",
                  fontWeight: 600,
                  fontSize: "0.85rem",
                  cursor: "pointer"
                }}
              >
                ดูบริการทั้งหมด
              </button>
            </div>
          ) : (
            <div style={{ display: "grid", gap: "20px" }}>
              {Object.entries(groupedOfferings).map(([catName, items]) => (
                <section key={catName} style={{ display: "grid", gap: "10px" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                      <div style={{ width: "4px", height: "16px", background: "var(--grape-deep)", borderRadius: "4px" }} />
                      <h3 style={{ margin: 0, fontSize: "0.98rem", fontWeight: 700, color: "var(--ink)" }}>
                        {catName}
                      </h3>
                    </div>
                    <span style={{ fontSize: "0.76rem", color: "var(--muted)" }}>
                      {items.length} รายการ
                    </span>
                  </div>

                  <div style={{ display: "grid", gap: "10px" }}>
                    {items.map((offering) => {
                      const isSelected = selectedService?.id === offering.id;
                      const imageUrl = getServiceImage(offering);
                      const priceVal = offering.price?.amount != null ? baht(offering.price.amount) : "฿750";
                      const durationVal = offering.durationMinutes ? `${offering.durationMinutes} นาที` : "60 นาที";
                      const depositVal = offering.price?.amount ? `มัดจำ ฿${Math.min(300, Math.round(offering.price.amount * 0.3))}` : "มัดจำ ฿200";

                      return (
                        <article
                          key={offering.id}
                          onClick={(e) => toggleSelect(offering, e)}
                          style={{
                            borderRadius: "18px",
                            background: "#fff",
                            border: isSelected ? "2px solid var(--grape-deep)" : "1px solid var(--line-soft)",
                            padding: "14px",
                            display: "grid",
                            gap: "8px",
                            boxShadow: isSelected ? "0 4px 18px rgba(106, 76, 255, 0.12)" : "0 2px 8px rgba(27, 22, 64, 0.03)",
                            cursor: "pointer",
                            transition: "all 0.15s ease"
                          }}
                        >
                          <div style={{ display: "flex", alignItems: "flex-start", gap: "12px" }}>
                            <div style={{ position: "relative", width: "72px", height: "72px", borderRadius: "14px", overflow: "hidden", flexShrink: 0, background: "var(--surface-container)" }}>
                              <img
                                src={imageUrl}
                                alt={offering.name}
                                style={{ width: "100%", height: "100%", objectFit: "cover" }}
                              />
                            </div>

                            <div style={{ flex: 1, minWidth: 0 }}>
                              <h4 style={{ margin: 0, fontSize: "0.95rem", fontWeight: 700, color: "var(--ink)", lineHeight: 1.3 }}>
                                {offering.name}
                              </h4>
                              {offering.category && (
                                <p style={{ margin: "2px 0 0", fontSize: "0.78rem", color: "var(--muted)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                                  {offering.category}
                                </p>
                              )}
                              <div style={{ display: "flex", flexWrap: "wrap", gap: "6px", marginTop: "6px" }}>
                                <span style={{
                                  display: "inline-flex",
                                  alignItems: "center",
                                  gap: "3px",
                                  background: "var(--surface-container)",
                                  padding: "2px 6px",
                                  borderRadius: "6px",
                                  fontSize: "0.72rem",
                                  color: "var(--ink)"
                                }}>
                                  ⏱ {durationVal}
                                </span>
                                <span style={{
                                  display: "inline-flex",
                                  alignItems: "center",
                                  gap: "3px",
                                  background: "var(--selected)",
                                  color: "var(--grape-deep)",
                                  padding: "2px 6px",
                                  borderRadius: "6px",
                                  fontSize: "0.72rem",
                                  fontWeight: 600
                                }}>
                                  🔒 {depositVal}
                                </span>
                              </div>
                            </div>
                          </div>

                          {offering.description && (
                            <p style={{ margin: "2px 0 0", fontSize: "0.8rem", color: "var(--on-surface-variant)", lineHeight: 1.4 }}>
                              {offering.description}
                            </p>
                          )}

                          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", borderTop: "1px solid var(--line-soft)", paddingTop: "8px", marginTop: "2px" }}>
                            <div style={{ display: "flex", alignItems: "baseline", gap: "4px" }}>
                              <span style={{ fontSize: "1.1rem", fontWeight: 800, color: "var(--grape-deep)" }}>
                                {priceVal}
                              </span>
                              <span style={{ fontSize: "0.74rem", color: "var(--muted)" }}>/ ท่าน</span>
                            </div>

                            <button
                              type="button"
                              onClick={(e) => toggleSelect(offering, e)}
                              style={{
                                display: "inline-flex",
                                alignItems: "center",
                                gap: "4px",
                                padding: "6px 14px",
                                borderRadius: "10px",
                                border: 0,
                                background: isSelected ? "#65fdb5" : "var(--grape-deep)",
                                color: isSelected ? "#002112" : "#fff",
                                fontSize: "0.8rem",
                                fontWeight: 700,
                                cursor: "pointer",
                                boxShadow: isSelected ? "0 2px 6px rgba(101, 253, 181, 0.4)" : "0 2px 8px rgba(106, 76, 255, 0.2)",
                                transition: "all 0.15s ease"
                              }}
                            >
                              <span>{isSelected ? "✓ เลือกแล้ว" : "+ เลือกจอง"}</span>
                            </button>
                          </div>
                        </article>
                      );
                    })}
                  </div>
                </section>
              ))}
            </div>
          )}

          {/* Booking Transparency Note */}
          <div style={{
            marginTop: "20px",
            padding: "14px",
            borderRadius: "16px",
            background: "var(--surface-container-low)",
            border: "1px solid var(--line-soft)"
          }}>
            <div style={{ display: "flex", alignItems: "center", gap: "6px", color: "var(--grape-deep)", fontWeight: 700, fontSize: "0.84rem", marginBottom: "6px" }}>
              <span>ℹ️</span>
              <span>คำแนะนำสำหรับการจองคิวออนไลน์</span>
            </div>
            <ul style={{ margin: 0, paddingLeft: "18px", fontSize: "0.78rem", color: "var(--on-surface-variant)", lineHeight: 1.6 }}>
              <li>ยอดมัดจำจะถูกนำไปหักเต็มจำนวนจากยอดบิลจริงในวันเข้ารับบริการ</li>
              <li>สามารถเปลี่ยนช่างผู้เชี่ยวชาญหรือเพิ่มบริการเสริมได้ในขั้นตอนถัดไป</li>
              <li>สอบถามแอดมินหรือส่งรูปประเมินสภาพผมล่วงหน้าทาง LINE OA ได้ตลอดเวลา</li>
            </ul>
          </div>
        </main>

        {/* Bottom Quick Sticky Bar (Stitch Screen 10 Drawer) */}
        <aside style={{
          position: "fixed",
          bottom: 0,
          left: 0,
          right: 0,
          zIndex: 50,
          background: "rgba(255, 255, 255, 0.96)",
          backdropFilter: "blur(16px)",
          borderTop: "1px solid var(--line-soft)",
          padding: "10px 16px",
          paddingBottom: "max(12px, env(safe-area-inset-bottom))",
          boxShadow: "0 -4px 20px rgba(0, 0, 0, 0.06)"
        }}>
          <div style={{ maxWidth: "480px", margin: "0 auto", display: "flex", justifyContent: "space-between", alignItems: "center", gap: "12px" }}>
            <div style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
              <span style={{ fontSize: "0.74rem", color: "var(--muted)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", lineHeight: 1.2 }}>
                {selectedService ? "เลือกแล้ว 1 บริการ" : "ยังไม่ได้เลือกบริการ"}
              </span>
              <div style={{ display: "flex", alignItems: "baseline", gap: "4px", lineHeight: 1.2, marginTop: "2px" }}>
                <strong style={{ fontSize: "1.2rem", color: "var(--grape-deep)", fontWeight: 800 }}>
                  {priceAmount > 0 ? baht(priceAmount) : "฿0"}
                </strong>
                <span style={{ fontSize: "0.72rem", color: "var(--muted)" }}>
                  (มัดจำ {depositAmount > 0 ? baht(depositAmount) : "฿0"})
                </span>
              </div>
            </div>

            <a
              href={selectedService ? `/b/${shop.slug}?offeringId=${selectedService.id}` : `/b/${shop.slug}`}
              style={{
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                gap: "6px",
                height: "44px",
                padding: "0 18px",
                borderRadius: "14px",
                background: "#65fdb5",
                color: "#002112",
                fontWeight: 700,
                fontSize: "0.86rem",
                textDecoration: "none",
                whiteSpace: "nowrap",
                flexShrink: 0,
                boxShadow: "0 2px 10px rgba(101, 253, 181, 0.45)",
                transition: "transform 0.12s ease"
              }}
            >
              <span>ไปหน้าจองคิว (Step 1)</span>
              <span style={{ fontSize: "1rem", lineHeight: 1 }}>➔</span>
            </a>
          </div>
        </aside>

        {/* Floating Toast Notification */}
        {toast && (
          <div style={{
            position: "fixed",
            bottom: "80px",
            left: "50%",
            transform: "translateX(-50%)",
            background: "#181445",
            color: "#fff",
            padding: "8px 18px",
            borderRadius: "30px",
            fontSize: "0.82rem",
            fontWeight: 600,
            zIndex: 9999,
            boxShadow: "0 6px 20px rgba(0,0,0,0.25)",
            whiteSpace: "nowrap"
          }}>
            {toast}
          </div>
        )}
      </div>
    </CustomerFrame>
  );
}
