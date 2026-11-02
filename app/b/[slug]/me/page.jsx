import { notFound } from "next/navigation";
import publicBooking from "../../../../src/v2/public-booking.js";
import v2db from "../../../../src/v2/db.js";
import platformSettings from "../../../../src/v2/platform-settings.js";
import MyBookingsClient from "./my-bookings-client.jsx";
import "../booking-v2.css";

export const dynamic = "force-dynamic";

// The customer's own bookings: private to them, so out of search engines
export const metadata = { title: "การจองของฉัน", robots: { index: false, follow: false }, referrer: "no-referrer" };

export default async function MyBookingsPage({ params }) {
  const { slug } = await params;
  let shop;
  try {
    shop = await publicBooking.shopInfo(v2db.getBookingPool(), slug);
  } catch (error) {
    if (error?.status === 404) notFound();
    throw error;
  }
  const liffId = await platformSettings.getSetting(v2db.getBookingPool(), "line.liff_id");
  return <MyBookingsClient shop={{ slug: shop.slug, name: shop.name, media: shop.media }} liffId={liffId || null} />;
}
