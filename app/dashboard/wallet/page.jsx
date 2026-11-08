import WalletClient from "./wallet-client.jsx";
import "../dashboard.css";
import "../../ui/ui.css";

export const dynamic = "force-dynamic";
export const metadata = { title: "แพ็กเกจและการชำระเงิน" };

// /dashboard/wallet — แพ็กเกจและการชำระเงินของแบรนด์ (app/dashboard/billing-panel.jsx)
export default function WalletPage() {
  return <WalletClient />;
}
