// Salon Booking OS v1 - Financial Lock Ordering Specification
// To prevent deadlocks, ALL multi-table operations touching financial records
// MUST acquire locks strictly in this ascending order:

/**
 * Strict Global Financial Lock Hierarchy:
 * 1. payments row            (SELECT ... FROM payments WHERE id = $1 FOR UPDATE)
 * 2. bookings row            (SELECT ... FROM bookings WHERE id = $1 FOR UPDATE)
 * 3. payment_allocations row (SELECT ... FROM payment_allocations WHERE payment_id = $1 FOR UPDATE)
 * 4. refunds row             (SELECT ... FROM refunds WHERE id = $1 FOR UPDATE)
 * 
 * Rules:
 * - A transaction must NEVER acquire a lower-numbered lock after acquiring a higher-numbered lock.
 * - If both payment and booking need to be locked, lock payment FIRST, then booking SECOND.
 * - If allocations need to be locked, lock payment FIRST, booking SECOND, allocation THIRD.
 * - If refunds need to be locked, lock payment FIRST, then refund row.
 */
const FINANCIAL_LOCK_ORDER = Object.freeze({
  PAYMENT: 1,
  BOOKING: 2,
  ALLOCATION: 3,
  REFUND: 4
});

/**
 * Validates that requested locks follow strict ascending order.
 * Useful for assertions in development/tests.
 */
function validateLockAcquisitionOrder(acquiredLocks, newLock) {
  if (!acquiredLocks || acquiredLocks.length === 0) return true;
  const lastLock = acquiredLocks[acquiredLocks.length - 1];
  const lastOrder = FINANCIAL_LOCK_ORDER[lastLock.toUpperCase()];
  const newOrder = FINANCIAL_LOCK_ORDER[newLock.toUpperCase()];

  if (lastOrder === undefined || newOrder === undefined) {
    throw new Error(`Unknown lock entity: ${lastLock} or ${newLock}`);
  }

  if (newOrder < lastOrder) {
    throw new Error(
      `Deadlock prevention violation: Attempted to acquire lock '${newLock}' (level ${newOrder}) ` +
      `after '${lastLock}' (level ${lastOrder}). Must follow: payment -> booking -> allocation -> refund.`
    );
  }
  return true;
}

module.exports = {
  FINANCIAL_LOCK_ORDER,
  validateLockAcquisitionOrder
};
