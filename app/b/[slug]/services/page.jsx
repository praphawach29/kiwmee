import { notFound } from "next/navigation";
import publicBooking from "../../../../src/v2/public-booking.js";
import v2db from "../../../../src/v2/db.js";
import platformSettings from "../../../../src/v2/platform-settings.js";
import ServicesCatalogClient from "./services-catalog-client.jsx";
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
    title: shop ? `บริการและราคา · ${shop.name}` : "ไม่พบร้าน",
    description: shop ? `เมนูบริการและราคามาตรฐานของ ${shop.name} พร้อมจองคิวออนไลน์ผ่าน LINE OA` : undefined
  };
}

export default async function ServicesCatalogPage({ params }) {
  const { slug } = await params;
  const shop = await loadShop(slug);
  if (!shop) notFound();

  const liffId = await platformSettings.getSetting(v2db.getBookingPool(), "line.liff_id");
  return <ServicesCatalogClient shop={shop} liffId={liffId || null} />;
}

