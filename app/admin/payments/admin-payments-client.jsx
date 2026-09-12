"use client";

import { useEffect, useState } from "react";
import AdminGate from "../admin-gate.jsx";

export default function AdminPaymentsClient() {
  const [payments, setPayments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [selectedReview, setSelectedReview] = useState(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [actionPending, setActionPending] = useState(false);
  const [confirmApproveOpen, setConfirmApproveOpen] = useState(false);
  const [rejectDialogOpen, setRejectDialogOpen] = useState(false);
  const [rejectReason, setRejectReason] = useState("STAFF_MANUAL_REJECTION");
  const [rejectNotes, setRejectNotes] = useState("");
  const [approveNotes, setApproveNotes] = useState("");
  const [actionSuccess, setActionSuccess] = useState("");

  useEffect(() => {
    loadPayments();
  }, []);

  async function loadPayments() {
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/admin/payments");
      const data = await res.json();
      if (!res.ok) throw new Error(data.error?.message || "Failed to load payment queue");
      setPayments(data.data?.payments || []);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function viewReviewDetail(paymentId) {
    setLoadingDetail(true);
    setError("");
    try {
      const res = await fetch(`/api/admin/payments/${paymentId}/review`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error?.message || "Failed to load review details");
      setSelectedReview(data.data?.review);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoadingDetail(false);
    }
  }

  async function handleApprove() {
    if (!selectedReview) return;
    setActionPending(true);
    setError("");
    try {
      const res = await fetch(`/api/admin/payments/${selectedReview.payment_id}/review`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "approve", notes: approveNotes })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error?.message || "Approval failed");
      setActionSuccess("อนุมัติการชำระเงินและยืนยันการจองเรียบร้อยแล้วค่ะ");
      setConfirmApproveOpen(false);
      setSelectedReview(null);
      await loadPayments();
    } catch (err) {
      setError(err.message);
    } finally {
      setActionPending(false);
    }
  }

  async function handleReject() {
    if (!selectedReview) return;
    setActionPending(true);
    setError("");
    try {
      const res = await fetch(`/api/admin/payments/${selectedReview.payment_id}/review`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "reject",
          reasonCode: rejectReason,
          notes: rejectNotes
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error?.message || "Rejection failed");
      setActionSuccess("ปฏิเสธสลิปเรียบร้อยแล้วค่ะ");
      setRejectDialogOpen(false);
      setSelectedReview(null);
      await loadPayments();
    } catch (err) {
      setError(err.message);
    } finally {
      setActionPending(false);
    }
  }

  return (
    <AdminGate>
      <main className="app-shell">
        <header className="topbar">
          <a className="brand" href="/admin">
            <strong>Salon Booking OS</strong>
            <span>Payments Queue</span>
          </a>
          <nav className="nav-links">
            <a href="/admin">กลับหน้าหลัก Admin</a>
            <a href="/admin/payments" className="active">รายการรอตรวจสอบ ({payments.length})</a>
          </nav>
        </header>

        <section className="workspace admin-layout">
          <div className="work-panel">
            <div className="panel-heading">
              <h1>Manual Payment Review Pilot</h1>
              <p>รายการสลิปและหลักฐานการโอนเงินที่ต้องให้พนักงานตรวจสอบและยืนยัน</p>
            </div>

            <div className="admin-toolbar">
              <button className="ghost-button" onClick={loadPayments} disabled={loading}>
                {loading ? "กำลังโหลด..." : "รีเฟรชรายการ"}
              </button>
              {actionSuccess && <span style={{ color: "#16a34a", fontWeight: "bold" }}>{actionSuccess}</span>}
              {error && <span style={{ color: "#dc2626", fontWeight: "bold" }}>{error}</span>}
            </div>

            {loading ? (
              <div className="state">กำลังโหลดรายการรอตรวจสอบ...</div>
            ) : payments.length === 0 ? (
              <div className="state">ไม่มีรายการรอตรวจสอบในขณะนี้ ✨</div>
            ) : (
              <div className="list">
                {payments.map((item) => (
                  <div className="handoff-row" key={item.payment_id} style={{ alignItems: "flex-start" }}>
                    <div style={{ flex: 1 }}>
                      <strong>{item.booking_reference} · {item.customer_name}</strong>
                      <div className="meta" style={{ marginTop: "4px", fontSize: "0.85rem", color: "#666" }}>
                        <span>บริการ: {item.service_name}</span> · 
                        <span>ช่าง: {item.staff_name}</span> · 
                        <span>นัดหมาย: {new Date(item.appointment_start).toLocaleString("th-TH")}</span>
                      </div>
                      <div style={{ marginTop: "6px" }}>
                        <span style={{ fontWeight: "bold" }}>ยอดที่ต้องชำระ: ฿{item.amount_due}</span>
                        {item.verified_amount !== null && (
                          <span style={{ marginLeft: "12px", color: Number(item.verified_amount) === Number(item.amount_due) ? "#16a34a" : "#dc2626" }}>
                            ยอดในสลิป: ฿{item.verified_amount}
                          </span>
                        )}
                        <span style={{ marginLeft: "12px" }}>
                          ผู้รับ: <span className={`status ${item.receiver_match_status}`}>{item.receiver_match_status}</span>
                        </span>
                        <span style={{ marginLeft: "12px" }}>
                          สลิปซ้ำ: <span className={`status ${item.duplicate_status}`}>{item.duplicate_status}</span>
                        </span>
                      </div>
                      <div style={{ fontSize: "0.8rem", color: "#888", marginTop: "4px" }}>
                        รอการตรวจมาแล้ว {item.payment_age_minutes} นาที (ผู้ให้บริการ: {item.provider})
                      </div>
                    </div>
                    <button
                      className="primary-button"
                      onClick={() => viewReviewDetail(item.payment_id)}
                      disabled={loadingDetail}
                    >
                      ตรวจสอบหลักฐาน
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {selectedReview && (
            <div className="work-panel" style={{ border: "2px solid #2563eb", background: "#f8fafc" }}>
              <div className="panel-heading" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <div>
                  <h2>หลักฐานการชำระเงิน: {selectedReview.booking?.reference}</h2>
                  <p>ตรวจสอบความถูกต้องของข้อมูลก่อนยืนยันหรือปฏิเสธ</p>
                </div>
                <button className="ghost-button" onClick={() => setSelectedReview(null)}>ปิดหน้าต่าง</button>
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "16px", margin: "16px 0" }}>
                <div style={{ background: "#fff", padding: "12px", borderRadius: "8px", border: "1px solid #e2e8f0" }}>
                  <h3 style={{ fontSize: "0.95rem", marginBottom: "8px" }}>ข้อมูลนัดหมาย</h3>
                  <div><strong>รหัสจอง:</strong> {selectedReview.booking?.reference}</div>
                  <div><strong>สถานะจอง:</strong> {selectedReview.booking?.status}</div>
                  <div><strong>ยอดที่ต้องชำระ:</strong> ฿{selectedReview.evidence?.expected_amount} {selectedReview.currency}</div>
                  <div><strong>อายุรายการ:</strong> {selectedReview.payment_age_minutes} นาที</div>
                </div>

                <div style={{ background: "#fff", padding: "12px", borderRadius: "8px", border: "1px solid #e2e8f0" }}>
                  <h3 style={{ fontSize: "0.95rem", marginBottom: "8px" }}>ข้อมูลที่ระบบตรวจพบ (EasySlip)</h3>
                  <div>
                    <strong>ยอดเงินในสลิป:</strong> ฿{selectedReview.evidence?.verified_amount ?? "ไม่พบ"}
                    {selectedReview.evidence?.amount_match ? " (ตรงกับยอดจอง ✅)" : " (ไม่ตรง ❌)"}
                  </div>
                  <div><strong>ผลตรวจบัญชีผู้รับ:</strong> {selectedReview.evidence?.receiver_match_status}</div>
                  <div><strong>Fingerprint สลิป:</strong> {selectedReview.evidence?.trans_ref_fingerprint ?? "-"}</div>
                  <div><strong>เวลาในสลิป:</strong> {selectedReview.evidence?.transaction_timestamp ? new Date(selectedReview.evidence?.transaction_timestamp).toLocaleString("th-TH") : "-"}</div>
                  <div><strong>สัญญาณสลิปซ้ำ:</strong> {selectedReview.evidence?.duplicate_signal ? "ตรวจพบสลิปซ้ำ ⚠️" : "ไม่พบประวัติซ้ำ"}</div>
                </div>
              </div>

              <div style={{ margin: "16px 0" }}>
                <h3 style={{ fontSize: "0.95rem", marginBottom: "8px" }}>ประวัติการตรวจ (Payment Attempts)</h3>
                <div className="list">
                  {selectedReview.attempts?.map((att, idx) => (
                    <div key={att.id} style={{ background: "#fff", padding: "8px", borderRadius: "6px", border: "1px solid #e2e8f0", fontSize: "0.85rem" }}>
                      <div>
                        <strong>#{idx + 1} {att.verification_provider}</strong> · ผลลัพธ์: {att.normalized_result} · ผู้รับ: {att.verified_receiver || "-"}
                      </div>
                      <div style={{ color: "#666" }}>
                        เวลาตรวจ: {new Date(att.created_at).toLocaleString("th-TH")} · Fingerprint: {att.trans_ref_fingerprint}
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              <div style={{ display: "flex", gap: "12px", marginTop: "20px" }}>
                <button
                  className="primary-button"
                  style={{ background: "#16a34a" }}
                  onClick={() => setConfirmApproveOpen(true)}
                  disabled={actionPending}
                >
                  อนุมัติการชำระเงิน (Approve)
                </button>
                <button
                  className="ghost-button"
                  style={{ color: "#dc2626", borderColor: "#dc2626" }}
                  onClick={() => setRejectDialogOpen(true)}
                  disabled={actionPending}
                >
                  ปฏิเสธสลิป (Reject)
                </button>
              </div>
            </div>
          )}

          {/* Approve Confirmation Modal */}
          {confirmApproveOpen && (
            <div style={{ position: "fixed", top: 0, left: 0, right: 0, bottom: 0, background: "rgba(0,0,0,0.5)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000 }}>
              <div style={{ background: "#fff", padding: "24px", borderRadius: "12px", maxWidth: "450px", width: "90%" }}>
                <h2>ยืนยันการอนุมัติ</h2>
                <p>ท่านได้ตรวจสอบหลักฐานยอดเงิน ฿{selectedReview?.evidence?.expected_amount} แล้วใช่หรือไม่?</p>
                <p style={{ fontSize: "0.85rem", color: "#666" }}>
                  เมื่ออนุมัติ ระบบจะเปลี่ยนสถานะการจองเป็น <strong>Confirmed</strong> และส่งบัตรยืนยันการจองไปยัง LINE ของลูกค้าทันที
                </p>
                <div style={{ marginTop: "12px" }}>
                  <label className="field">
                    <span>บันทึกเพิ่มเติม (ไม่บังคับ):</span>
                    <input type="text" value={approveNotes} onChange={(e) => setApproveNotes(e.target.value)} placeholder="เช่น ยอดเงินเข้าบัญชีเรียบร้อย" />
                  </label>
                </div>
                <div style={{ display: "flex", justifyContent: "flex-end", gap: "12px", marginTop: "16px" }}>
                  <button className="ghost-button" onClick={() => setConfirmApproveOpen(false)} disabled={actionPending}>ยกเลิก</button>
                  <button className="primary-button" onClick={handleApprove} disabled={actionPending}>
                    {actionPending ? "กำลังอนุมัติ..." : "ยืนยันอนุมัติ"}
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Reject Modal */}
          {rejectDialogOpen && (
            <div style={{ position: "fixed", top: 0, left: 0, right: 0, bottom: 0, background: "rgba(0,0,0,0.5)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000 }}>
              <div style={{ background: "#fff", padding: "24px", borderRadius: "12px", maxWidth: "450px", width: "90%" }}>
                <h2>ปฏิเสธการชำระเงิน</h2>
                <p>โปรดระบุสาเหตุที่ปฏิเสธสลิปนี้:</p>
                <div style={{ margin: "12px 0" }}>
                  <label className="field">
                    <span>สาเหตุ:</span>
                    <select value={rejectReason} onChange={(e) => setRejectReason(e.target.value)}>
                      <option value="STAFF_MANUAL_REJECTION">สลิปไม่ถูกต้อง / ยอดเงินไม่เข้า</option>
                      <option value="AMOUNT_MISMATCH">ยอดเงินไม่ตรงตามที่กำหนด</option>
                      <option value="RECEIVER_MISMATCH">โอนเงินผิดบัญชีผู้รับ</option>
                      <option value="DUPLICATE_SLIP">สลิปซ้ำกับรายการอื่น</option>
                      <option value="INVALID_SLIP">รูปภาพไม่ใช่สลิปโอนเงิน</option>
                    </select>
                  </label>
                  <label className="field" style={{ marginTop: "8px" }}>
                    <span>หมายเหตุถึงลูกค้า:</span>
                    <input type="text" value={rejectNotes} onChange={(e) => setRejectNotes(e.target.value)} placeholder="เช่น โปรดส่งสลิปฉบับเต็มที่มี QR" />
                  </label>
                </div>
                <div style={{ display: "flex", justifyContent: "flex-end", gap: "12px", marginTop: "16px" }}>
                  <button className="ghost-button" onClick={() => setRejectDialogOpen(false)} disabled={actionPending}>ยกเลิก</button>
                  <button className="primary-button" style={{ background: "#dc2626" }} onClick={handleReject} disabled={actionPending}>
                    {actionPending ? "กำลังปฏิเสธ..." : "ยืนยันปฏิเสธ"}
                  </button>
                </div>
              </div>
            </div>
          )}
        </section>
      </main>
    </AdminGate>
  );
}
