// In-process API transport. AI tools never receive a repository, SQL client or credentials.
const services = require("../../../app/api/services/route");
const staff = require("../../../app/api/staff/route");
const availability = require("../../../app/api/availability/route");
const create = require("../../../app/api/bookings/route");
const detail = require("../../../app/api/bookings/[id]/route");
const reschedule = require("../../../app/api/bookings/[id]/reschedule/route");
const cancel = require("../../../app/api/bookings/[id]/cancel/route");

async function invoke(handler, path, { body, phone, id } = {}) {
  const request = new Request(`http://salon.internal${path}`, {
    method: body ? "POST" : "GET", headers: { "content-type": "application/json", ...(phone ? { "x-booking-phone": phone } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  const response = await handler(request, { params: { id } });
  const result = await response.json();
  if (!response.ok) { const error = new Error("Booking API failed"); error.code = result.error?.code; throw error; }
  return result.data;
}
const apiClient = {
  services: () => invoke(services.GET, "/api/services"),
  staff: (service_id) => invoke(staff.GET, `/api/staff?${new URLSearchParams({ service_id })}`),
  availability: (args) => invoke(availability.GET, `/api/availability?${new URLSearchParams(Object.entries(args).filter(([, v]) => v !== null))}`),
  detail: (id, phone) => invoke(detail.GET, `/api/bookings/${id}`, { id, phone }),
  create: (body) => invoke(create.POST, "/api/bookings", { body }),
  reschedule: (id, phone, body) => invoke(reschedule.POST, `/api/bookings/${id}/reschedule`, { id, phone, body }),
  cancel: (id, phone) => invoke(cancel.POST, `/api/bookings/${id}/cancel`, { id, phone, body: { actor: "customer", reason: "customer via receptionist" } })
};
module.exports = { apiClient };
