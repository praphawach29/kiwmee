import AdminBookingDetailClient from "./admin-booking-detail-client.jsx";

export default async function AdminBookingDetailPage({ params }) {
  const resolvedParams = await params;
  return <AdminBookingDetailClient bookingId={resolvedParams.id} />;
}
