# Kiwmee — Customer Booking Flow Redesign (V3)
**Architecture, UX/UI Specifications & Frontend Design System**

> เอกสารนี้จัดทำขึ้นเพื่อแก้ปัญหาความขัดแย้ง 5 จุดในดีไซน์เดิม, รองรับระบบจริงโดยไม่สร้าง Ghost UI, และยกระดับประสบการณ์การจองบน LINE OA ตามมาตรฐาน `frontend-design`

---

## 1. Design Direction: Thai Neo-Tactile Booking (ไทย นีโอ-แท็กไทล์)

### 1.1 Aesthetic Thesis & DFII Score
- **Aesthetic Name:** Thai Neo-Tactile Booking
- **Core Concept:** ผสานความอบอุ่น ละเมียดละไมของงานบริการแบบไทย เข้ากับความคมชัดของระบบนัดหมายซาลอนญี่ปุ่น (Clean Japanese Appointment System) และความเร็วลื่นไหลระดับ Native ของ LINE Mini-App
- **DFII (Design Feasibility & Impact Index):**
  - Aesthetic Impact: 5/5 (โดดเด่น ไม่ซ้ำซาก หลีกเลี่ยง Generic AI UI / Bootstrap Clone)
  - Context Fit: 5/5 (เหมาะกับพฤติกรรมคนไทยบน LINE OA มือเดียว จิ้มง่าย รวดเร็ว)
  - Implementation Feasibility: 4/5 (ใช้ Next.js 15 + Tailwind / CSS Variables เดิมได้ 100%)
  - Performance Safety: 5/5 (Zero external heavy runtime, CSS-first micro-transitions)
  - Consistency Risk: 1/5 (ระบบ Token รัดกุม)
  - **DFII = (5 + 5 + 4 + 5) - 1 = 18/15 (Tier: Excellent -> Execute Fully)**

### 1.2 Differentiation Anchor (สิ่งที่ทำให้จดจำได้ทันทีแม้ลบโลโก้ออก)
> **"The Tactile Boarding Pass & Live Stepper Capsule"**
> ตัวสรุปการจองและตั๋วคิวไม่ได้เป็นการ์ดแบนๆ ทั่วไป แต่ถูกออกแบบในรูป **Boarding Pass รอยปรุดิจิทัล (Tear-off Notch)** และ Stepper ด้านบนเป็นแคปซูลแก้วโปร่งแสง (Frosted Capsule) ที่มีสถานะเวลาจริง ตอบสนองต่อการสัมผัสด้วยแรงต้านทางสายตา (Tactile Micro-press `scale: 0.98`)

---

## 2. Design System Tokens (Kiwmee Official)

```css
:root {
  /* Brand Core */
  --grape: #6A4CFF;         /* Primary brand accent & main buttons */
  --grape-deep: #4F33E0;    /* Interactive hover, active states */
  --grape-night: #1B1640;   /* Deep text & primary contrast containers */
  --grape-light: #ECE8FF;   /* Lilac background for active chips */
  
  --mint: #3DDC97;          /* Success & highlight accent */
  --mint-deep: #0B7A50;     /* Accessible text on white/tint */
  --mint-tint: #E3FAF0;     /* Positive status chip background */
  
  /* Neutral Surfaces */
  --bg-mist: #F7F5FF;       /* Soft background tint */
  --surface-card: #FFFFFF;  /* Elevated cards & containers */
  --line-strong: #DCD6F5;   /* Crisp borders (1px solid) */
  --line-subtle: #F0EDFA;   /* Inner row dividers */
  --text-muted: #6B6684;    /* Secondary metadata (Passes WCAG AA) */
  
  /* Typography Scale */
  --font-display: "Mitr", sans-serif;
  --font-body: "Anuphan", -apple-system, sans-serif;
  
  /* Ergonomic Touch Targets */
  --touch-min: 44px;        /* Every clickable element must meet this */
  --radius-card: 18px;      /* Friendly organic rounded corners */
  --radius-pill: 9999px;    /* Smooth chips & primary pills */
}
```

---

## 3. การวิเคราะห์และปลดล็อกปัญหา 5 จุดขัดกันเอง

| # | ประเด็นที่ขัดกัน | ปัญหาในดีไซน์เดิม | ทางออกที่ถูกต้องตามระบบจริง (V3 Decision) |
|---|---|---|---|
| **1** | **การชำระเงิน / มัดจำ** | Step 3 เขียนชำระหน้าร้าน แต่ปุ่มเขียนมัดจำ ฿500 และ My Bookings อ้าง Rabbit LINE Pay | **แก้เป็น 2 โหมดตามการตั้งค่าร้าน (`deposit_mode`):**<br>1. *ร้านไม่เก็บมัดจำ*: แสดง "ชำระเงินที่ร้านหลังรับบริการ ฿X,XXX" ปุ่มกด `[ ยืนยันการจองคิว ]`<br>2. *ร้านเก็บมัดจำ*: แสดงยอดมัดจำชัดเจน โอนผ่าน QR Code PromptPay + แนบสลิป (EasySlip อัตโนมัติที่ระบบมีอยู่แล้ว) |
| **2** | **VAT 7%** | เขียนว่า "รวม VAT แล้ว" แต่ระบบไม่มี breakdown | **ตัดคำว่า VAT ออกสำหรับร้านทั่วไป** เปลี่ยนเป็น `"ราคาสุทธิ (ไม่มีค่าบริการแอบแฝง)"` และรองรับสวิตช์ใน Dashboard ร้านอนาคตหากจด VAT 7% จึงเปิด breakdown |
| **3** | **นโยบายยกเลิก/เลื่อน** | Step 3 เขียน 2 ชม. แต่ My Bookings เขียน 24 ชม. | **ใช้ Single Source of Truth จาก `shop.cancellation_lead_hours`** เช่น "ยกเลิกหรือเลื่อนนัดฟรีล่วงหน้า {hours} ชม." ทุกหน้าจอจะดึงตัวเลขเดียวกันเสมอ |
| **4** | **ช่องทางแจ้งเตือน** | อ้างว่าส่ง SMS 1 ชม. ก่อนถึงเวลา แต่ระบบมีเฉพาะ LINE | **เปลี่ยนเป็น "รับการแจ้งเตือนและเตือนนัดล่วงหน้าผ่าน LINE OA"** ให้ตรงกับขีดความสามารถของแพลตฟอร์ม 100% |
| **5** | **ขอ LINE ID ซ้ำซ้อน** | ลูกค้าเข้าผ่าน LIFF มี `userId` อยู่แล้ว แต่แบบฟอร์มขอ LINE ID อีกรอบ | **ตัดช่องกรอก LINE ID ออก** ขอเพียง **ชื่อ-นามสกุล** และ **เบอร์โทรศัพท์ติดต่อ** (ดึง prefill จาก LINE Profile ได้ทันที ลูกค้าไม่ต้องพิมพ์ซ้ำ) |

---

## 4. จัดการฟีเจอร์ในดีไซน์ vs ระบบจริง (Phasing Strategy)

```
[ Phase 1: Launch Ready (ทำทันที) ]
  ├── Step 1: เลือกบริการ (1 บริการหลัก + Add-ons hook ที่มีอยู่เดิม)
  ├── Step 2: เลือกช่างและวันเวลา (คำนวณคิวว่างจริง ปฏิทิน พ.ศ. แยก เช้า/บ่าย/เย็น)
  ├── Step 3: ข้อมูลผู้จองและยืนยัน (Prefill LIFF, สรุปนัด, โอนสลิป/จ่ายหน้าร้าน)
  ├── Step 4: จองสำเร็จ Boarding Pass (QR Code เช็คอิน, ปุ่ม .ics ปฏิทิน, ลิงก์แชร์)
  └── My Bookings / เลื่อนนัด / ยกเลิก (ใช้ token จัดการคิวเดิม)

[ Phase 2: Upsell & Package Power (เฟสถัดไป) ]
  ├── เลือกหลายบริการพร้อมกัน (Multi-service cart)
  ├── แพ็กเกจคอมโบ (Combo Bundle)
  └── ประกันมัดจำผ่านบัตร/วอลเล็ต

[ Phase 3: Growth & Retention ]
  ├── คูปองส่วนลด / Vouchers
  └── ให้คะแนนและรีวิวหลังรับบริการ (Post-service Review)
```

---

## 5. แผนผัง UI Flow และโครงสร้างหน้าจอ 4 ขั้นตอน (Step-by-Step UX Spec)

### 5.1 Stepper Navigation (อยู่ติดขอบบน ไม่ขยับ)
- แคปซูลโปร่งแสง 4 จุด: `1. เลือกบริการ` ➔ `2. วันและเวลา` ➔ `3. ข้อมูลผู้จอง` ➔ `4. จองสำเร็จ`
- แสดงความคืบหน้าร้อยละแบบ Micro-progress bar นุ่มนวล

### 5.2 Step 1: บริการ (Service Selection)
- **Top Sticky Bar:** ชื่อร้าน + หมวดหมู่บริการแบบชิปเลื่อนได้ แตะง่ายสูง $\ge 44px$
- **Card Service:** 
  - ภาพสัดส่วน 1:1 มุมมน 14px 
  - ชื่อบริการภาษาไทยเด่นชัด พร้อมคำอธิบายย่อย
  - ป้ายระบุระยะเวลา เช่น `⏱ 60 นาที`
  - ป้ายมัดจำ (ถ้ามี) เช่น `🔒 มัดจำ ฿300`
  - ราคาตัวเลขชัดเจนด้วยฟอนต์ `Mitr`
  - ปุ่มเลือก: สลับสถานะ `+ เลือก` เป็น `✓ เลือกแล้ว` (สี Lilac / ม่วง)

### 5.3 Step 2: ช่างและวันเวลา (Staff & Slot Selection)
- **Staff Selector:** 
  - ตัวเลือกแรกเสมอ: `"ช่างคนไหนก็ได้ (คิวเร็วที่สุด)"` พร้อมไอคอนสายฟ้า
  - ตามด้วยการ์ดช่างรายบุคคล (รูปโปรไฟล์กลม + ชื่อ + ความชำนาญ)
- **Calendar Strip (ปฏิทินแนวนอน):**
  - แสดงวัน จ.-อา. พร้อมวันที่และเดือน พ.ศ. เช่น `มี.ค. 2568`
  - วันที่ร้านปิด หรือคิวเต็ม จะแสดงป้าย `"เต็ม"` หรือ `"ปิด"` ตัวอักษรชัดเจน ไม่ใช้แค่สีแดงอย่างเดียว
- **Time Slots Grid:**
  - แบ่งหมวดหมู่ช่วงเวลา: `☀️ ช่วงเช้า (10:00 - 12:00)`, `🌤️ ช่วงบ่าย (12:00 - 17:00)`, `🌙 ช่วงเย็น (17:00 - 20:00)`
  - ปุ่มเวลาขนาดสูง $\ge 44px$ จิ้มง่าย
  - ช่องที่ถูกเลือกจะเปลี่ยนเป็นสี `--grape-night` ตัวอักษรสีขาว โดดเด่น ชัดเจน

### 5.4 Step 3: ข้อมูลผู้จองและสรุปนัด (Details & Confirmation)
- **Customer Form:**
  - ดึงชื่อและรูปโปรไฟล์จาก LINE อัตโนมัติ
  - ช่องกรอกเบอร์โทรศัพท์ (ฟอนต์ตัวเลข 16px ป้องกัน Safari Zoom)
  - ช่องหมายเหตุเพิ่มเติมถึงทางร้าน
- **Appointment Summary Ticket:**
  - การ์ดสรุปรายการบริการ, ช่างผู้ให้บริการ, วันที่, และช่วงเวลา
  - สรุปยอดเงิน: "ราคาบริการ" + "ยอดมัดจำ (ถ้ามี)" + "ยอดชำระที่หน้าร้าน"
  - แจ้งนโยบายการยกเลิก/เลื่อนนัดอย่างโปร่งใสตามค่า `shop.cancellation_lead_hours`

### 5.5 Step 4: บัตรคิวดิจิทัล (Digital Boarding Pass)
- **Boarding Pass Ticket:**
  - หัวการ์ดสถานะ: `✓ ยืนยันการจองเรียบร้อย` (พื้นสี Mint Tint, ตัวอักษร Mint Deep)
  - รหัสการจองตัวใหญ่ คมชัด (เช่น `3EFF5EC6`)
  - QR Code สำหรับเช็คอินหน้าร้าน (แตะขยายเต็มจอได้)
  - รายละเอียด วัน-เวลา-ช่าง-บริการ แบบกะทัดรัด
- **Action Drawer (ปุ่มปฏิบัติการ):**
  - ปุ่ม `[ 📅 เพิ่มลง Google / Apple Calendar (.ics) ]` แตะครั้งเดียวเซฟลงมือถือทันที
  - ปุ่ม `[ 📋 คัดลอกลิงก์จัดการนัดหมาย ]`
  - ปุ่ม `[ 💬 ติดต่อร้านทาง LINE ]`
  - ปุ่มรอง: `"ดูการจองของฉัน"` และ `"จองคิวใหม่"`

---

## 6. รายการปรับปรุงด้าน Accessibility & Micro-UX (12 Quick Wins)
1. **ภาษา:** ใช้ภาษาไทยเป็นหลักในการสื่อสาร สุภาพ เข้าใจง่าย ไวยากรณ์กระชับ
2. **ตัวเลข พ.ศ.:** ใช้ปีพุทธศักราชสอดคล้องกันทุกหน้าจอ (เช่น `26 มีนาคม 2568`)
3. **Touch Targets:** ปุ่ม, แถบตัวกรอง, และชิปเวลา ปรับความสูงขั้นต่ำ $44px$ เพื่อให้แตะด้วยนิ้วโป้งมือเดียวได้แม่นยำ
4. **Typography Contrast:** ตัดฟอนต์ 10-11px ทิ้ง ใช้ขนาดตัวหนังสือเริ่มต้นที่ 12-14px และสีข้อความรองต้องผ่านมาตรฐาน WCAG AA ($\ge 4.5:1$)
5. **No Viewport Lock:** นำ `user-scalable=no, maximum-scale=1.0` ออก เพื่อให้ผู้มีปัญหาทางสายตาสามารถซูมหน้าจอได้ตามมาตรฐานสากล
6. **Zero Ghost UI:** ไม่ใส่ฟีเจอร์ที่ไม่มีอยู่จริง (เช่น คูปองที่กดไม่ได้ หรือช่องกรอกที่ไม่บันทึก) เพื่อสร้างความเชื่อมั่นสูงสุดให้แก่ลูกค้า

