import ShopAdmin from "./shop-admin-client.jsx";
import "../dashboard.css";

export const dynamic = "force-dynamic";
export const metadata = { title: "ตั้งค่าร้าน" };

export default async function ShopAdminPage({ params }) {
  const { slug } = await params;
  return <ShopAdmin slug={slug} />;
}
