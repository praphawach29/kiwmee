import WalletClient from "./wallet-client.jsx";
import "../dashboard.css";

export const dynamic = "force-dynamic";
export const metadata = { title: "กระเป๋าเงิน" };

// /dashboard/wallet — ยอดเงิน เติมด้วยสลิป และซื้อแพ็กเกจ/แพ็กเสริม (migration …003700)
export default function WalletPage() {
  return <WalletClient />;
}
