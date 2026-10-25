import adminAuth from "../../src/v2/admin-auth.js";
import DashboardHome from "./dashboard-home-client.jsx";
import "./dashboard.css";

export const dynamic = "force-dynamic";
export const metadata = { title: "จัดการร้าน" };

// Supabase Auth runs in the browser (see src/v2/admin-auth.js); its URL and publishable key are public
export default function DashboardPage() {
  return <DashboardHome auth={adminAuth.authConfig()} />;
}
