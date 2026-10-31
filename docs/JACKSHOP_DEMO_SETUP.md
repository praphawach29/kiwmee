# JackShop: ติดตั้งบริการตัวอย่างอย่างจำกัดขอบเขต

ไฟล์ `scripts/sql/jackshop-demo-services.sql` เป็น **operational seed ที่เจ้าของต้องอนุมัติและรันเอง** ไม่ใช่ migration และไม่ถูกเรียกจาก deploy / `supabase db reset` อัตโนมัติ การเตรียมไฟล์นี้ไม่ได้หมายความว่ามีการรันบน production แล้ว

## ลำดับติดตั้ง

1. ตรวจว่าเลือก Supabase **booking-v2** (`ezubgqeqdipwfnmorqkj`) เท่านั้น ห้ามใช้ v1
2. ใช้ migration ใหม่สำหรับ `public.businesses.media` และ `public.offerings.media` (ไฟล์ลำดับ `20261025001400_*`) **ก่อน deploy โค้ดที่อ่านคอลัมน์นี้** รูปแบบ JSONB เป็น array ของ `{ "url": "...", "alt": "..." }` สูงสุด 8 รูป
3. Deploy โค้ดและ assets `public/demo-media/badminton.svg`, `tennis.svg`, `football.svg` แล้วตรวจว่า URL `/demo-media/<ชื่อ>.svg` ของ deployment เปิดได้จริง เป็นภาพประกอบต้นฉบับ ไม่ใช่รูปสถานที่จริง
4. หยุดแก้ไข catalog ชั่วคราว ให้เจ้าของตรวจ SQL แล้วรัน **ทั้งไฟล์** ใน SQL Editor ของ booking-v2 ด้วยสิทธิ์ DB owner ที่อ่าน `auth.users` และตรวจ collision ข้าม tenant ได้ ห้ามตัด guard / transaction หรือเปลี่ยนเป็น migration อัตโนมัติ สำหรับ CLI ใช้ `psql -v ON_ERROR_STOP=1 -f scripts/sql/jackshop-demo-services.sql` กับ connection ที่ตรวจสอบแล้วเท่านั้น
5. ตรวจผล readback ว่ามี **3 แถวตาม UUID ที่ระบุท้ายไฟล์** และตรวจ warning เรื่อง flow ก่อนทดสอบหน้าจอง `/b/jackshop` ตรวจหน้าร้านและบริการว่ารูปมีคำว่า “ภาพประกอบ…ไม่ใช่ภาพสถานที่จริง”

## บริการที่เพิ่ม

| ชื่อ | บาท/ชั่วโมง | รูป | UUID ท้าย |
|---|---:|---|---|
| [ตัวอย่าง] สนามแบดมินตัน | 200 | `/demo-media/badminton.svg` | `…0101` |
| [ตัวอย่าง] สนามเทนนิส | 300 | `/demo-media/tennis.svg` | `…0102` |
| [ตัวอย่าง] สนามฟุตบอล | 1200 | `/demo-media/football.svg` | `…0103` |

ทุกบริการใช้ `customer_choice` 60–180 นาที เพิ่มทีละ 60 นาที ผูกสนามชนิด `court` ของตัวเองเพียงหนึ่งแห่ง `capacity = 1` และ requirement `units_per_booking = one`, `customer_picks = true` การกันจองซ้อนแบบ exclusive มาจาก trigger เดิมที่อ่าน capacity ไม่ใช่คอลัมน์ใหม่บน resource ไม่มีการสร้าง booking ใด ๆ และราคา/คำอธิบายระบุว่าเป็นตัวอย่าง ไม่ใช่การยืนยันราคาจริง

## Guard และสิ่งที่คงไว้

- ค้น business ID จาก slug `jackshop` เท่านั้น ต้องเป็น kind `court` และ brand `6ca1c8b4-94cf-4fb8-8f68-38634ec40cb5`
- อีเมล `praphawach@gmail.com` ต้องตรงกับผู้ใช้เพียงหนึ่งราย และเป็น owner ทั้งใน `business_members` และ `brand_members` ของเป้าหมาย ไม่สร้าง membership หรือแก้ owner
- Namespace UUID `7d91c600-74b1-4ac7-9801-*` คงที่: offering `…0101–0103`, resource `…0201–0203`, requirement `…0301–0303`, price `…0401–0403`, fallback flow `…0500` ตรวจ collision ข้ามตาราง demo และข้าม tenant ก่อนเขียน หากข้อมูลเดิมไม่ตรง manifest หรือเจ้าของแก้ demo แล้ว ให้หยุดและตรวจด้วยคน **ไม่ reset ทับ**
- `INSERT ON CONFLICT DO NOTHING` สำหรับ catalog, rates, links และ fallback ต่าง ๆ ไม่สร้างราคาซ้ำเมื่อรันซ้ำ ไม่ลบข้อมูล ไม่เปลี่ยนบริการ/ทรัพยากรจริง
- Gallery เพิ่มรูป demo ที่ URL ยังไม่มีต่อท้าย **เก็บรูปเดิมและลำดับเดิมทั้งหมด** ไม่ทำซ้ำตาม URL ถ้ารวมแล้วเกิน 8 รูปจะ rollback ทั้งหมด ให้เจ้าของเลือกจัดการพื้นที่เอง ไม่ลบรูปจริงหรือแอบข้ามบางรูป
- Hours: เพิ่ม 10:00–19:00 ทุกวัน **เฉพาะกรณีไม่มีแถวเวลาทำการเลย** ถ้ามีบางวันแล้ว ไม่เติมวันที่หายเพราะอาจเป็นความตั้งใจปิดร้าน ไม่เพิ่ม resource schedules ให้ engine ใช้เวลาร้านเดิม ไม่มีการแตะ closures / time off
- Settings: เพิ่มค่าเริ่มต้นเฉพาะกรณีไม่มีแถวเดิมเท่านั้น ไม่แตะ lead time, interval, cancellation หรือ settings ปัจจุบัน
- Flow: เพิ่ม default flow ที่บังคับ `offering, resource, duration, date, time` เฉพาะกรณีไม่มี default flow เลย **ไม่เขียนทับ flow เดิม** หากของเดิมขาด resource/duration หรือ input ที่จำเป็น SQL จะเตือน เจ้าของต้อง preview → apply → Save template **จองสนาม / ห้อง / อุปกรณ์** (`resource_slot`) หรือปรับ flow เองหลังตรวจผลกระทบบริการอื่น ไม่ถือว่าร้านพร้อมรับจองเพียงเพราะ seed สำเร็จ
- ไม่แก้ RLS / grants / schema ใช้สิทธิ์ operator เดิม การเปลี่ยน shop จำกัดแค่ gallery (trigger เดิมปรับ `updated_at` ตามปกติ)

มี advisory lock และ table locks ระยะสั้นกันการแก้ catalog พร้อมกัน ตั้ง lock timeout 5 วินาที / statement timeout 30 วินาที ถ้าล็อกไม่ได้จะหยุด ไม่ควรเรียกซ้ำวนในช่วงที่มีคนใช้งานหนาแน่น

Assertion หลังเขียนตรวจค่าของ demo ทั้ง 4 ตาราง ตารางละ 3 แถว รวมถึง rate, requirement, court link, capacity และ gallery หาก assertion/constraint/guard ใดผิดพลาด transaction จะ abort ให้ rollback แล้วตรวจสาเหตุก่อนรันใหม่ ห้ามลบ guard เพื่อให้ผ่าน

## ขอบเขตการยืนยัน

การตรวจ schema และไฟล์ในเครื่องไม่ยืนยัน production identity, การ deploy assets หรือความพร้อมจองจริง ต้องตรวจจาก deployment และ readback หลังเจ้าของรันตามขั้นตอนข้างต้น งานนี้ไม่อนุญาตให้รัน seed บน production โดยอัตโนมัติ
