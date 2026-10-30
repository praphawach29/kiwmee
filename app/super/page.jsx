import SuperAdmin from "./super-admin-client.jsx";
import "../dashboard/dashboard.css";
import "./super.css";

export const dynamic = "force-dynamic";
export const metadata = { title: "ผู้ดูแลแพลตฟอร์ม", robots: { index: false, follow: false } };

export default function SuperPage() {
  return <SuperAdmin />;
}
