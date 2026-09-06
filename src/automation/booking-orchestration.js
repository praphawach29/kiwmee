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

const createBooking = (repository, input) => perform(repository, core.createBooking,
  [input], automation.handleBookingCreated);
const rescheduleBooking = (repository, id, input) => perform(repository, core.rescheduleBooking,
  [id, input], automation.handleBookingRescheduled);
const cancelBooking = (repository, id, input, config) => perform(repository, core.cancelBooking,
  [id, input, config], automation.handleBookingCancelled);
const updateBookingStatus = (repository, id, input) => perform(repository, core.updateBookingStatus,
  [id, input], async (tx, booking) => {
    const handlers = {
      confirmed: automation.handleBookingCreated,
      completed: automation.handleBookingCompleted,
      cancelled: automation.handleBookingCancelled,
      no_show: automation.handleBookingNoShow
    };
    await handlers[booking.status]?.(tx, booking);
  });

module.exports = { createBooking, rescheduleBooking, cancelBooking, updateBookingStatus };
