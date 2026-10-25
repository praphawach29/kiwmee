import Link from "next/link";
import "./landing.css";

// Kiwmee landing page. The demo link opens the sample shop from supabase/seed.sql.
const DEMO = "/b/bloom-hair";

const BUSINESSES = [
  { name: "ร้านเสริมสวย", flow: "เลือกวันหรือบริการก่อนก็ได้ แล้วเลือกช่าง หรือ “ใครก็ได้”" },
  { name: "ร้านตัดผมชาย", flow: "เลือกบริการ ระบบหาช่างที่ว่างให้เอง" },
  { name: "สปา / นวด", flow: "เลือกวัน แล้วดูว่าบริการไหนยังว่าง" },
  { name: "สนามกีฬา", flow: "เลือกสนาม วัน เวลาเริ่ม และจำนวนชั่วโมง ราคาเย็นต่างจากกลางวันได้" },
  { name: "คลาส / เวิร์กช็อป", flow: "รอบละหลายคน ระบบนับที่นั่งให้" }
];

const FEATURES = [
  { title: "เห็นเฉพาะคิวที่ว่างจริง", text: "ปิดร้าน ช่างลา หรือคิวเต็ม ระบบเทาไว้พร้อมบอกเหตุผล ลูกค้าไม่ต้องทักมาถาม", icon: "check" },
  { title: "ไม่มีจองชน", text: "สองคนกดช่วงเวลาเดียวกันพร้อมกัน ระบบรับคนแรก อีกคนเลือกเวลาใหม่ได้ทันที", icon: "shield" },
  { title: "ตั้งขั้นตอนจองเอง", text: "เลือกได้ว่าให้ลูกค้าเริ่มจากวัน บริการ หรือช่าง พร้อมดูตัวอย่างก่อนบันทึก", icon: "flow" },
  { title: "ราคาตามวันและเวลา", text: "ราคาเสาร์–อาทิตย์ ช่วงเย็น หรือคิดรายชั่วโมง ตั้งเองได้ ระบบคิดให้ตอนจอง", icon: "tag" },
  { title: "ช่าง สนาม ห้อง ตามที่ร้านมี", text: "ตารางงานรายวัน วันลา วันหยุดร้าน ตั้งชื่อชนิดเองได้ เช่น เก้าอี้นวด", icon: "people" },
  { title: "เปิดใน LINE ได้", text: "หน้าจองเดียวกันเปิดในแอป LINE เติมชื่อลูกค้าให้อัตโนมัติ", icon: "chat" }
];

const STEPS = [
  { title: "สมัครและเปิดร้าน", text: "ใช้อีเมลสมัคร ตั้งชื่อร้านและลิงก์หน้าจองของคุณ" },
  { title: "ใส่บริการ ช่าง และเวลาทำการ", text: "เลือกแบบสำเร็จรูปตามประเภทร้าน แล้วปรับเพิ่มได้" },
  { title: "ส่งลิงก์ให้ลูกค้า", text: "แปะในเมนู LINE OA, Facebook, Instagram หรือ Google Maps" }
];

const ICONS = {
  check: <path d="M5 12.5l4.5 4.5L19 7.5" />,
  shield: <path d="M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6l7-3z M9 12l2 2 4-4" />,
  flow: <path d="M4 6h6v4H4z M14 14h6v4h-6z M7 10v4a2 2 0 002 2h5" />,
  tag: <path d="M3 12V4h8l10 10-8 8L3 12z M7.5 7.5h.01" />,
  people: <path d="M9 11a3.5 3.5 0 100-7 3.5 3.5 0 000 7z M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6 M16 4.5a3.5 3.5 0 010 6.5 M21 20c0-2.6-1.6-4.8-4-5.6" />,
  chat: <path d="M4 5h16v11H9l-5 4V5z M8 10h8 M8 13h5" />
};

function Icon({ name }) {
  return (
    <svg className="lp-icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      {ICONS[name]}
    </svg>
  );
}

function PhoneDemo() {
  const times = ["10:00", "10:30", "11:00", "13:00", "14:30", "16:00"];
  return (
    <div className="lp-phone" aria-label="ตัวอย่างหน้าจองบนมือถือ" role="img">
      <div className="lp-phone-head">
        <strong>Bloom Hair &amp; Beauty</strong>
        <span>จองคิวออนไลน์</span>
      </div>
      <div className="lp-phone-chips">
        <span>พฤ. 30 ต.ค.</span>
        <span>ทำสีผม</span>
        <span>ช่างแนน</span>
      </div>
      <div className="lp-phone-card">
        <strong>เลือกเวลา</strong>
        <div className="lp-phone-times">
          {times.map((t) => (
            <span key={t} data-on={t === "14:30"}>{t}</span>
          ))}
        </div>
      </div>
      <div className="lp-phone-foot">
        <span>ทำสีผม · 2 ชม. · 1,500 บาท</span>
        <b>ยืนยันการจอง</b>
      </div>
    </div>
  );
}

export default function LandingPage() {
  return (
    <div className="lp">
      <header className="lp-header">
        <div className="lp-wrap lp-header-row">
          <Link href="/" aria-label="Kiwmee หน้าแรก">
            <img src="/brand/kiwmee-logo.svg" alt="kiwmee" className="lp-logo" />
          </Link>
          <nav className="lp-nav" aria-label="เมนู">
            <a href="#features">ฟีเจอร์</a>
            <a href="#business">ใช้กับร้านแบบไหน</a>
            <a href="#start">เริ่มใช้งาน</a>
          </nav>
          <Link href="/dashboard" className="lp-btn lp-btn-ghost">เข้าสู่ระบบ</Link>
        </div>
      </header>

      <main>
        <section className="lp-hero">
          <div className="lp-wrap lp-hero-grid">
            <div className="lp-hero-text">
              <p className="lp-kicker">ระบบจองคิวออนไลน์สำหรับทุกธุรกิจที่รับจอง</p>
              <h1>จองคิวง่าย<br />ได้ทุกที่</h1>
              <p className="lp-lead">
                ลูกค้าเลือกวัน บริการ และช่างได้เอง เห็นเฉพาะเวลาที่ว่างจริง จองผ่านเว็บหรือใน LINE ก็ได้
                ร้านไม่ต้องตอบแชทถามคิวทั้งวัน
              </p>
              <div className="lp-actions">
                <Link href="/dashboard" className="lp-btn lp-btn-primary">เปิดร้านของคุณ</Link>
                <Link href={DEMO} className="lp-btn lp-btn-secondary">ลองจองร้านตัวอย่าง</Link>
              </div>
            </div>
            <PhoneDemo />
          </div>
        </section>

        <section id="features" className="lp-section">
          <div className="lp-wrap">
            <h2>ร้านตั้งเองได้ ลูกค้าจองเองได้</h2>
            <div className="lp-features">
              {FEATURES.map((f) => (
                <article key={f.title} className="lp-card">
                  <Icon name={f.icon} />
                  <h3>{f.title}</h3>
                  <p>{f.text}</p>
                </article>
              ))}
            </div>
          </div>
        </section>

        <section id="business" className="lp-section lp-section-tint">
          <div className="lp-wrap">
            <h2>ใช้ได้กับร้านแบบไหน</h2>
            <p className="lp-sub">แต่ละร้านตั้งลำดับการจองให้เข้ากับงานของตัวเอง ไม่ต้องเขียนโค้ด</p>
            <ul className="lp-business">
              {BUSINESSES.map((b) => (
                <li key={b.name}>
                  <strong>{b.name}</strong>
                  <span>{b.flow}</span>
                </li>
              ))}
            </ul>
          </div>
        </section>

        <section id="start" className="lp-section">
          <div className="lp-wrap">
            <h2>เริ่มรับจองใน 3 ขั้น</h2>
            <ol className="lp-steps">
              {STEPS.map((s, i) => (
                <li key={s.title}>
                  <span className="lp-step-no">{i + 1}</span>
                  <h3>{s.title}</h3>
                  <p>{s.text}</p>
                </li>
              ))}
            </ol>
          </div>
        </section>

        <section className="lp-cta">
          <div className="lp-wrap lp-cta-row">
            <div>
              <h2>พร้อมให้ลูกค้าจองเองแล้วหรือยัง</h2>
              <p>เปิดร้านแล้วส่งลิงก์หน้าจองให้ลูกค้าได้ทันที</p>
            </div>
            <Link href="/dashboard" className="lp-btn lp-btn-mint">เปิดร้านของคุณ</Link>
          </div>
        </section>
      </main>

      <footer className="lp-footer">
        <div className="lp-wrap lp-footer-row">
          <img src="/brand/kiwmee-logo-dark.svg" alt="kiwmee" className="lp-logo" />
          <span>© 2569 Kiwmee · จองคิวง่าย ได้ทุกที่</span>
        </div>
      </footer>
    </div>
  );
}
