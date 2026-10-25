import { notFound } from "next/navigation";
import publicBooking from "../../../src/v2/public-booking.js";
import v2db from "../../../src/v2/db.js";
import BookingV2Client from "./booking-v2-client.jsx";
import "./booking-v2.css";

export const dynamic = "force-dynamic";

async function loadShop(slug) {
  try {
    return await publicBooking.shopInfo(v2db.getBookingPool(), slug);
  } catch (error) {
    if (error?.status === 404) return null;
    throw error;
  }
}

export async function generateMetadata({ params }) {
  const { slug } = await params;
  const shop = await loadShop(slug);
  return { title: shop ? `จองคิว · ${shop.name}` : "ไม่พบร้าน" };
}

export default async function ShopBookingPage({ params }) {
  const { slug } = await params;
  const shop = await loadShop(slug);
  if (!shop) notFound();
  return <BookingV2Client shop={shop} liffId={process.env.NEXT_PUBLIC_LIFF_ID || null} />;
}
