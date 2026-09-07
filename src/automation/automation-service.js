const { updateBookingStatus } = require("../booking-service");
const { getBookingConfig } = require("../config");
const { addMinutes } = require("../time");
const { ConsoleNotificationProvider } = require("./providers");
const { transactionScope } = require("./transaction-scope");

const JOB_TYPES = {
  confirmation: "booking_confirmation",
  reminder: "appointment_reminder",
  cancellation: "booking_cancellation",
  noShowFollowup: "no_show_followup",
  postServiceFollowup: "post_service_followup"
};

async function handleBookingCreated(repository, booking, config = getBookingConfig()) {
  if (booking.status !== "confirmed") {
    return { confirmation: null, reminder: null };
  }

  return repository.transaction(async (tx) => ({
    confirmation: await enqueueConfirmation(tx, booking),
    reminder: await enqueueReminder(tx, booking, config)
  }));
}

async function handleBookingRescheduled(repository, booking, config = getBookingConfig()) {
  return repository.transaction(async (tx) => {
    await tx.cancelPendingAutomationJobs(booking.id, [JOB_TYPES.reminder],
      `booking-reminder:${booking.id}:${scheduleVersion(booking)}`);
    return {
      confirmation: await enqueueConfirmation(tx, booking),
      reminder: await enqueueReminder(tx, booking, config)
    };
  });
}

async function handleBookingCancelled(repository, booking) {
  return repository.transaction(async (tx) => {
    await tx.cancelPendingAutomationJobs(booking.id, [JOB_TYPES.reminder]);
    return {
      cancellation: await tx.enqueueAutomationJob({
        booking_id: booking.id,
        automation_type: JOB_TYPES.cancellation,
        event_key: `booking-cancelled:${booking.id}`,
        scheduled_at: new Date().toISOString(),
        payload: buildPayload(booking)
      })
    };
  });
}

async function handleBookingCompleted(repository, booking, config = getBookingConfig()) {
  return repository.transaction(async (tx) => ({
    postServiceFollowup: await enqueuePostServiceFollowup(tx, booking, config)
  }));
}

async function handleBookingNoShow(repository, booking, config = getBookingConfig()) {
  return repository.transaction(async (tx) => ({
    noShowFollowup: await enqueueNoShowFollowup(tx, booking, new Date(), config)
  }));
}

async function runAutomationCycle(repository, options = {}) {
  const config = options.config ?? getBookingConfig();
  const provider = options.provider ?? new ConsoleNotificationProvider();
  const now = options.now ? new Date(options.now) : new Date();

  const noShowResult = await detectNoShows(repository, now, config);
  const reconciliation = await reconcileAutomationJobs(repository, config);
  await repository.refreshPendingReminderSchedule?.(config.reminderHoursBefore);
  const shadowMode = provider.deliveryMode === "shadow";
  const processed = shadowMode ? [] : await processDueAutomationJobs(repository, provider, {
    now,
    limit: options.limit
  });

  return {
    reconciled: reconciliation,
    no_show_detected: noShowResult.length,
    shadow_mode: shadowMode,
    jobs_processed: processed.length,
    jobs: processed
  };
}

async function reconcileAutomationJobs(repository, config = getBookingConfig()) {
  if (!repository.listBookingsForAutomationReconciliation) {
    return { confirmed: 0, cancelled: 0, no_show: 0, completed: 0 };
  }

  const bookings = await repository.listBookingsForAutomationReconciliation();
  const counts = { confirmed: 0, cancelled: 0, no_show: 0, completed: 0 };

  for (const booking of bookings) {
    if (booking.status === "confirmed") {
      await handleBookingCreated(repository, booking, config);
      counts.confirmed += 1;
    } else if (booking.status === "cancelled") {
      await handleBookingCancelled(repository, booking);
      counts.cancelled += 1;
    } else if (booking.status === "no_show") {
      await handleBookingNoShow(repository, booking, config);
      counts.no_show += 1;
    } else if (booking.status === "completed") {
      await handleBookingCompleted(repository, booking, config);
      counts.completed += 1;
    }
  }

  return counts;
}

async function detectNoShows(repository, now, config = getBookingConfig()) {
  const overdue = await repository.listConfirmedBookingsPastNoShowCutoff(
    addMinutes(now, -config.noShowGraceMinutes)
  );
  const updated = [];

  for (const booking of overdue) {
    const noShow = await repository.transaction(async (tx) => {
      const scope = transactionScope(tx);
      const current = await scope.getBookingForUpdate(booking.id);
      if (!current || current.status !== "confirmed" ||
          new Date(current.start_at) >= addMinutes(now, -config.noShowGraceMinutes)) return null;
      const changed = await updateBookingStatus(scope, booking.id, {
      status: "no_show",
      reason: "no-show detection",
      changed_by: "automation"
      });
      await scope.cancelPendingAutomationJobs(booking.id, [JOB_TYPES.reminder]);
      await enqueueNoShowFollowup(scope, changed, now, config);
      return changed;
    });

    if (noShow) updated.push(noShow);
  }

  return updated;
}

async function processDueAutomationJobs(repository, provider, options = {}) {
  const now = options.now ? new Date(options.now) : new Date();
  const limit = options.limit ?? 25;
  const jobs = await repository.claimDueAutomationJobs(now, limit);
  const results = [];

  for (const job of jobs) {
    try {
      const status = await repository.transaction(async (tx) => {
        const scope = transactionScope(tx);
        // Booking mutations acquire this same row lock, serializing dispatch with reschedule/cancel.
        const booking = await scope.getBookingForUpdate(job.booking_id);
        const current = scope.getAutomationJobForUpdate
          ? await scope.getAutomationJobForUpdate(job.id) : job;
        if (!current || current.status !== "processing" || current.attempts !== job.attempts) return "skipped";
        if (!isCurrentJob(job, booking, now)) {
          await scope.cancelAutomationJob(job.id);
          return "cancelled";
        }
        if (!await scope.hasAutomationLog(job.event_key)) await sendJob(provider, job);
        await scope.completeAutomationJob(job.id, {
        booking_id: job.booking_id,
        automation_name: job.automation_type,
        event_key: job.event_key,
        result: "completed"
        });
        return "completed";
      });
      results.push({ id: job.id, status, automation_type: job.automation_type });
    } catch (error) {
      await repository.failAutomationJob(job.id, "Notification delivery failed", now);
      require("../observability/logger").logEvent("automation_job_failure", { job_id: job.id,
        booking_id: job.booking_id, automation_type: job.automation_type, code: error.code ?? "PROVIDER_ERROR" });
      results.push({ id: job.id, status: "failed", automation_type: job.automation_type, error: error.message });
    }
  }

  return results;
}

async function enqueueConfirmation(repository, booking) {
  return repository.enqueueAutomationJob({
    booking_id: booking.id,
    automation_type: JOB_TYPES.confirmation,
    event_key: `booking-confirmed:${booking.id}:${scheduleVersion(booking)}`,
    scheduled_at: new Date().toISOString(),
    payload: buildPayload(booking)
  });
}

async function enqueueReminder(repository, booking, config) {
  return repository.enqueueAutomationJob({
    booking_id: booking.id,
    automation_type: JOB_TYPES.reminder,
    event_key: `booking-reminder:${booking.id}:${scheduleVersion(booking)}`,
    scheduled_at: addMinutes(new Date(booking.start_at), -config.reminderHoursBefore * 60).toISOString(),
    payload: buildPayload(booking)
  });
}

async function enqueuePostServiceFollowup(repository, booking, config) {
  return repository.enqueueAutomationJob({
    booking_id: booking.id,
    automation_type: JOB_TYPES.postServiceFollowup,
    event_key: `post-service-followup:${booking.id}`,
    scheduled_at: addMinutes(new Date(booking.updated_at ?? booking.end_at), config.postServiceFollowupHours * 60).toISOString(),
    payload: { ...buildPayload(booking), followup_type: "post_service_followup" }
  });
}

async function enqueueNoShowFollowup(repository, booking, now, config) {
  return repository.enqueueAutomationJob({
    booking_id: booking.id,
    automation_type: JOB_TYPES.noShowFollowup,
    event_key: `no-show-followup:${booking.id}`,
    scheduled_at: addMinutes(now, config.noShowFollowupHours * 60).toISOString(),
    payload: { ...buildPayload(booking), followup_type: "no_show_followup" }
  });
}

async function sendJob(provider, job) {
  const payload = { ...job.payload, idempotency_key: job.event_key };
  if (job.automation_type === JOB_TYPES.confirmation) {
    return provider.sendConfirmation(payload);
  }
  if (job.automation_type === JOB_TYPES.reminder) {
    return provider.sendReminder(payload);
  }
  if (job.automation_type === JOB_TYPES.cancellation) {
    return provider.sendCancellation(payload);
  }
  if (job.automation_type === JOB_TYPES.noShowFollowup || job.automation_type === JOB_TYPES.postServiceFollowup) {
    return provider.sendFollowUp(payload);
  }
  throw new Error(`unsupported automation type: ${job.automation_type}`);
}

function buildPayload(booking) {
  return {
    booking_id: booking.id,
    customer_id: booking.customer_id,
    service_id: booking.service_id,
    staff_id: booking.staff_id,
    start_at: booking.start_at,
    end_at: booking.end_at,
    status: booking.status,
    schedule_version: scheduleVersion(booking)
  };
}

function scheduleVersion(booking) {
  return `${booking.staff_id}:${new Date(booking.start_at).toISOString()}:${booking.updated_at ? new Date(booking.updated_at).toISOString() : "initial"}`;
}

function isCurrentJob(job, booking, now) {
  if (!booking) return false;
  if ([JOB_TYPES.reminder, JOB_TYPES.confirmation].includes(job.automation_type)) {
    return booking.status === "confirmed" && new Date(booking.start_at) > now &&
      job.payload.schedule_version === scheduleVersion(booking);
  }
  const required = {
    [JOB_TYPES.cancellation]: "cancelled",
    [JOB_TYPES.noShowFollowup]: "no_show",
    [JOB_TYPES.postServiceFollowup]: "completed"
  };
  return booking.status === required[job.automation_type];
}

module.exports = {
  JOB_TYPES,
  detectNoShows,
  handleBookingCancelled,
  handleBookingCompleted,
  handleBookingCreated,
  handleBookingNoShow,
  handleBookingRescheduled,
  processDueAutomationJobs,
  reconcileAutomationJobs,
  runAutomationCycle
};
