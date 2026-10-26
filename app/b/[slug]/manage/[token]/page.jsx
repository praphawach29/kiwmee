import { notFound } from "next/navigation";
import manageBooking from "../../../../../src/v2/manage-booking.js";
import v2db from "../../../../../src/v2/db.js";
import ManageBookingClient from "./manage-booking-client.jsx";
import "../../booking-v2.css";

export const dynamic = "force-dynamic";

// The link is the customer's key: keep it out of search engines and other sites' logs
export const metadata = {
  title: "การจองของคุณ",
  robots: { index: false, follow: false },
  referrer: "no-referrer"
};

export default async function ManageBookingPage({ params }) {
  const { slug, token } = await params;
  let view;
  try {
    view = await manageBooking.findManaged(v2db.getBookingPool(), slug, token);
  } catch (error) {
    if (error?.status === 404) notFound();
    throw error;
  }
  return <ManageBookingClient token={token} initial={view} />;
}
