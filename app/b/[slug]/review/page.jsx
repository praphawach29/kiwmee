import { notFound } from "next/navigation";
import publicBooking from "../../../../src/v2/public-booking.js";
import v2db from "../../../../src/v2/db.js";
import platformSettings from "../../../../src/v2/platform-settings.js";
import ReviewClient from "./review-client.jsx";
import "../booking-v2.css";

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
  return {
    title: shop ? `รีวิวและให้คะแนน · ${shop.name}` : "ไม่พบร้าน",
    robots: { index: false, follow: false }
  };
}

export default async function GeneralReviewPage({ params }) {
  const { slug } = await params;
  const shop = await loadShop(slug);
  if (!shop) notFound();

  const liffId = await platformSettings.getSetting(v2db.getBookingPool(), "line.liff_id");
  return <ReviewClient shop={shop} bookingId="demo" liffId={liffId || null} />;
}

