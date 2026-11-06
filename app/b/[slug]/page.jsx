import { notFound } from "next/navigation";
import publicBooking from "../../../src/v2/public-booking.js";
import v2db from "../../../src/v2/db.js";
import platformSettings from "../../../src/v2/platform-settings.js";
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
  // Directly start on the offering step so the customer sees the Stitch service catalog right away
  const [liffId, first] = await Promise.all([
    platformSettings.getSetting(v2db.getBookingPool(), "line.liff_id"),
    publicBooking.step(v2db.getBookingPool(), slug, { selected: {}, ask: "offering" }).catch(() =>
      publicBooking.step(v2db.getBookingPool(), slug, { selected: {} }).catch(() => null)
    )
  ]);
  return <BookingV2Client shop={shop} liffId={liffId || null} initialView={first} />;
}
