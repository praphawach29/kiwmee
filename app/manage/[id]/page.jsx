import ManageBookingClient from "./manage-booking-client.jsx";

export default async function ManageBookingPage({ params }) {
  const resolvedParams = await params;
  return <ManageBookingClient bookingId={resolvedParams.id} />;
}
