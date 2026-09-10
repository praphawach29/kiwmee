const core = require("../booking-service");
const automation = require("./automation-service");
const { transactionScope } = require("./transaction-scope");

async function perform(repository, operation, args, handler) {
  return repository.transaction(async (tx) => {
    const scope = transactionScope(tx);
    const booking = await operation(scope, ...args);
    await handler(scope, booking);
    return booking;
  });
}

const createBooking = (repository, input, options = {}) => perform(repository, core.createBooking,
  [input], (tx, booking) => automation.handleBookingCreated(tx, booking, undefined, options));
const rescheduleBooking = (repository, id, input, options = {}) => perform(repository, core.rescheduleBooking,
  [id, input], (tx, booking) => automation.handleBookingRescheduled(tx, booking, undefined, options));
const cancelBooking = (repository, id, input, config, options = {}) => {
  const isOptions = config && (config.businessId || config.entitlementService || config.hasFeatureFn);
  const cfg = isOptions ? undefined : config;
  const opts = isOptions ? config : (options || {});
  return perform(repository, core.cancelBooking,
    [id, input, cfg], (tx, booking) => automation.handleBookingCancelled(tx, booking, opts));
};
const updateBookingStatus = (repository, id, input, options = {}) => perform(repository, core.updateBookingStatus,
  [id, input], async (tx, booking) => {
    const handlers = {
      confirmed: (t, b) => automation.handleBookingCreated(t, b, undefined, options),
      completed: (t, b) => automation.handleBookingCompleted(t, b, undefined, options),
      cancelled: (t, b) => automation.handleBookingCancelled(t, b, options),
      no_show: (t, b) => automation.handleBookingNoShow(t, b, undefined, options)
    };
    await handlers[booking.status]?.(tx, booking);
  });

module.exports = { createBooking, rescheduleBooking, cancelBooking, updateBookingStatus };
