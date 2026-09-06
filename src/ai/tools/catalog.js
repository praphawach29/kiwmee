const Ajv = require("ajv");
const ajv = new Ajv({ allErrors: false, allowUnionTypes: true });
const string = { type: "string", minLength: 1, maxLength: 200 };
const uuid = { type: "string", pattern: "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$" };
const object = (properties) => ({ type: "object", additionalProperties: false, properties, required: Object.keys(properties) });
const service = object({ id: uuid, name: string, price: { type: ["string", "number", "null"] }, duration_minutes: { type: "integer", minimum: 1 } });
const staff = object({ id: uuid, name: string });
const slot = object({ staff_id: uuid, start_at: string, end_at: string });
const booking = object({ id: uuid, service_id: uuid, staff_id: uuid, start_at: string, end_at: string, status: string });
const array = (items) => ({ type: "array", items });
const schemas = {
  list_services: [{}, array(service), "List active services with current prices and durations."],
  get_service_details: [{ service_id: uuid }, service, "Read one active service from the real catalog."],
  list_staff: [{ service_id: uuid }, array(staff), "List active staff eligible for a service."],
  check_availability: [{ service_id: uuid, staff_id: { anyOf: [uuid, { type: "null" }] }, date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" } }, array(slot), "Return only slots from the existing availability API."],
  get_booking: [{ booking_id: uuid, phone: { type: "string", pattern: "^[+0-9 ()-]{9,24}$" } }, booking, "Read a booking after reference and phone verification."],
  create_booking_request: [{ review_id: uuid }, booking, "Create only the server-reviewed draft explicitly confirmed by this customer."],
  request_reschedule: [{ review_id: uuid }, booking, "Reschedule a verified booking after explicit confirmation of a server review."],
  request_cancel: [{ review_id: uuid }, booking, "Cancel a verified booking as the customer; never override policy."]
};
const tools = Object.entries(schemas).map(([name, [properties, data, description]]) => {
  const input_schema = object(properties);
  const output_schema = { anyOf: [object({ ok: { const: true }, data }), object({ ok: { const: false }, error: object({ code: string, message: string }) })] };
  return { name, description, strict: true, input_schema, output_schema,
    validateInput: ajv.compile(input_schema), validateOutput: ajv.compile(output_schema) };
});
module.exports = { tools };
