const { PgPaymentRepository, normalizePgError } = require("./pg-payment-repository");

let Pool;

const ACTIVE_STATUSES = ["pending", "confirmed", "checked_in", "completed"];

class PgBookingRepository extends PgPaymentRepository {
  constructor(options = {}) {
    super(options);
  }

  async close() {
    if (!this.client) {
      await this.pool.end();
    }
  }

  async transaction(callback) {
    if (this.client) {
      // Re-use existing transaction scope without spawning extra clients or BEGIN/COMMIT
      return callback(this);
    }
    const client = await this.pool.connect();
    const tx = new PgBookingRepository({ pool: this.pool, client });
    // If specific repository methods were mocked/overridden on this instance, pass them to tx
    if (this._overrides) {
      Object.assign(tx, this._overrides);
    }

    try {
      await client.query("begin");
      const result = await callback(tx);
      await client.query("commit");
      return result;
    } catch (error) {
      await client.query("rollback");
      throw normalizePgError(error);
    } finally {
      client.release();
    }
  }

  async query(text, params = []) {
    const runner = this.client ?? this.pool;
    try {
      const result = await runner.query(text, params);
      return result.rows;
    } catch (error) {
      throw normalizePgError(error);
    }
  }

  async lockStaffSchedule(staffId) {
    if (!this.client) {
      throw new Error("lockStaffSchedule must be called inside a transaction");
    }

    await this.client.query("select pg_advisory_xact_lock(hashtext($1), 0)", [staffId]);
    await this.client.query("select id from staff where id = $1 for update", [staffId]);
  }

  async getActiveService(serviceId) {
    const rows = await this.query(
      "select * from services where id = $1 and active = true",
      [serviceId]
    );
    return rows[0] ?? null;
  }

  async getActiveStaff(staffId) {
    const rows = await this.query(
      "select * from staff where id = $1 and active = true",
      [staffId]
    );
    return rows[0] ?? null;
  }

  async staffCanPerformService(staffId, serviceId) {
    const rows = await this.query(
      "select 1 from staff_services where staff_id = $1 and service_id = $2 limit 1",
      [staffId, serviceId]
    );
    return rows.length > 0;
  }

  async listActiveStaffForService(serviceId) {
    return this.query(
      `
        select staff.*
        from staff
        join staff_services on staff_services.staff_id = staff.id
        where staff_services.service_id = $1
          and staff.active = true
        order by staff.name, staff.id
      `,
      [serviceId]
    );
  }

  async listAllStaff() {
    return this.query(
      "select * from staff where active = true order by name, id"
    );
  }

  async listServices() {
    return this.query(
      "select * from services where active = true order by name, id"
    );
  }

  async listAvailabilityForStaff(staffId, start, end) {
    return this.query(
      `
        select *
        from availability
        where staff_id = $1
          and start_at < $3
          and end_at > $2
        order by start_at, end_at
      `,
      [staffId, start, end]
    );
  }

  async listBookingsForStaff(staffId, start, end, statuses = ACTIVE_STATUSES, excludeBookingId = null) {
    return this.query(
      `
        select *
        from bookings
        where staff_id = $1
          and status = any($4::text[])
          and start_at < $3
          and end_at > $2
          and ($5::uuid is null or id <> $5::uuid)
        order by start_at, end_at
      `,
      [staffId, start, end, statuses, excludeBookingId]
    );
  }

  async findCustomerByContact(contact) {
    const rows = await this.query(
      `
        select *
        from customers
        where ($1::text is not null and phone = $1)
           or ($2::text is not null and email = $2)
           or ($3::text is not null and line_user_id = $3)
        order by created_at
        limit 1
      `,
      [contact.phone, contact.email, contact.line_user_id]
    );
    return rows[0] ?? null;
  }

  async insertCustomer(customer) {
    const rows = await this.query(
      `
        insert into customers (name, phone, email, line_user_id, contact_channel, notes)
        values ($1, $2, $3, $4, $5, $6)
        returning *
      `,
      [
        customer.name,
        customer.phone,
        customer.email,
        customer.line_user_id,
        customer.contact_channel,
        customer.notes
      ]
    );
    return rows[0];
  }

  async insertBooking(booking) {
    if (booking.checkout_idempotency_key !== undefined && booking.checkout_idempotency_key !== null) {
      const rows = await this.query(
        `
          insert into bookings (customer_id, service_id, staff_id, start_at, end_at, status, source, notes, checkout_idempotency_key)
          values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
          returning *
        `,
        [
          booking.customer_id,
          booking.service_id,
          booking.staff_id,
          booking.start_at,
          booking.end_at,
          booking.status,
          booking.source,
          booking.notes,
          booking.checkout_idempotency_key
        ]
      );
      return rows[0];
    }

    const rows = await this.query(
      `
        insert into bookings (customer_id, service_id, staff_id, start_at, end_at, status, source, notes)
        values ($1, $2, $3, $4, $5, $6, $7, $8)
        returning *
      `,
      [
        booking.customer_id,
        booking.service_id,
        booking.staff_id,
        booking.start_at,
        booking.end_at,
        booking.status,
        booking.source,
        booking.notes
      ]
    );
    return rows[0];
  }

  async insertBookingStatusHistory(history) {
    const rows = await this.query(
      `
        insert into booking_status_history (booking_id, from_status, to_status, reason, changed_by)
        values ($1, $2, $3, $4, $5)
        returning *
      `,
      [
        history.booking_id,
        history.from_status,
        history.to_status,
        history.reason,
        history.changed_by
      ]
    );
    return rows[0];
  }

  async getBookingForUpdate(bookingId) {
    if (!this.client) {
      throw new Error("getBookingForUpdate must be called inside a transaction");
    }

    const rows = await this.query(
      "select * from bookings where id = $1 for update",
      [bookingId]
    );
    return rows[0] ?? null;
  }

  async updateBookingTime(bookingId, patch) {
    const rows = await this.query(
      `
        update bookings
        set staff_id = $2,
            start_at = $3,
            end_at = $4,
            status = $5
        where id = $1
        returning *
      `,
      [bookingId, patch.staff_id, patch.start_at, patch.end_at, patch.status]
    );
    return rows[0] ?? null;
  }

  async updateBookingStatus(bookingId, status) {
    const rows = await this.query(
      "update bookings set status = $2 where id = $1 returning *",
      [bookingId, status]
    );
    return rows[0] ?? null;
  }

  async getBooking(bookingId) {
    const rows = await this.query("select * from bookings where id = $1", [bookingId]);
    return rows[0] ?? null;
  }

  async getBookingById(bookingId) {
    return this.getBooking(bookingId);
  }

  async findBookingByIdempotencyKey(key) {
    const rows = await this.query("select * from bookings where checkout_idempotency_key = $1", [key]);
    return rows[0] ?? null;
  }

  async getPaymentsByBookingId(bookingId) {
    return this.query("select * from payments where original_booking_id = $1 order by created_at desc", [bookingId]);
  }

  async findPaymentByBookingId(bookingId) {
    const rows = await this.getPaymentsByBookingId(bookingId);
    return rows[0] ?? null;
  }

  async getBookingDetail(bookingId) {
    const rows = await this.query(
      `
        select
          bookings.*,
          row_to_json(customers) as customer,
          row_to_json(services) as service,
          row_to_json(staff) as staff,
          coalesce(
            json_agg(booking_status_history order by booking_status_history.changed_at)
              filter (where booking_status_history.id is not null),
            '[]'::json
          ) as history
        from bookings
        join customers on customers.id = bookings.customer_id
        join services on services.id = bookings.service_id
        join staff on staff.id = bookings.staff_id
        left join booking_status_history on booking_status_history.booking_id = bookings.id
        where bookings.id = $1
        group by bookings.id, customers.id, services.id, staff.id
      `,
      [bookingId]
    );
    return rows[0] ?? null;
  }

  async listAdminBookingsForDate(dateStart, dateEnd) {
    return this.query(
      `
        select
          bookings.*,
          row_to_json(customers) as customer,
          row_to_json(services) as service,
          row_to_json(staff) as staff
        from bookings
        join customers on customers.id = bookings.customer_id
        join services on services.id = bookings.service_id
        join staff on staff.id = bookings.staff_id
        where bookings.start_at < $2
          and bookings.end_at > $1
        order by bookings.start_at, staff.name
      `,
      [dateStart, dateEnd]
    );
  }

  async enqueueAutomationJob(job) {
    const rows = await this.query(
      `
        insert into automation_jobs (
          booking_id,
          automation_type,
          event_key,
          scheduled_at,
          payload
        )
        values ($1, $2, $3, $4, $5::jsonb)
        on conflict (event_key) do update
        set payload = automation_jobs.payload
        returning *
      `,
      [
        job.booking_id,
        job.automation_type,
        job.event_key,
        job.scheduled_at,
        JSON.stringify(job.payload ?? {})
      ]
    );
    return rows[0];
  }

  async cancelPendingAutomationJobs(bookingId, automationTypes, exceptEventKey = null) {
    return this.query(
      `
        update automation_jobs
        set status = 'cancelled',
            last_error = null
        where booking_id = $1
          and automation_type = any($2::text[])
          and status in ('pending', 'failed')
          and ($3::text is null or event_key <> $3)
        returning *
      `,
      [bookingId, automationTypes, exceptEventKey]
    );
  }

  async claimDueAutomationJobs(now, limit = 25) {
    return this.transaction(async (tx) => {
      const { automationMaxAttempts } = require("../config").getBookingConfig();
      await tx.query(`update automation_jobs set status = 'failed', dead_lettered_at = $1,
        last_error = coalesce(last_error, 'worker lease expired at retry limit')
        where dead_lettered_at is null and attempts >= $2 and
        (status = 'failed' or (status = 'processing' and updated_at < now() - interval '5 minutes'))`,
      [now, automationMaxAttempts]);
      const rows = await tx.query(
        `
          select *
          from automation_jobs
          where dead_lettered_at is null and attempts < $3 and
            ((status in ('pending', 'failed') and scheduled_at <= $1)
             or (status = 'processing' and updated_at < now() - interval '5 minutes'))
          order by scheduled_at, created_at
          limit $2
          for update skip locked
        `,
        [now, limit, automationMaxAttempts]
      );

      if (rows.length === 0) {
        return [];
      }

      const ids = rows.map((row) => row.id);
      return tx.query(
        `
          update automation_jobs
          set status = 'processing',
              attempts = attempts + 1,
              last_error = null
          where id = any($1::uuid[])
          returning *
        `,
        [ids]
      );
    });
  }

  async refreshPendingReminderSchedule(hours) {
    await this.query(`update automation_jobs j
      set scheduled_at = b.start_at - ($1::double precision * interval '1 hour')
      from bookings b where j.booking_id = b.id
      and j.automation_type = 'appointment_reminder' and j.status = 'pending'
      and b.status = 'confirmed' and (j.payload->>'start_at')::timestamptz = b.start_at
      and j.scheduled_at is distinct from b.start_at - ($1::double precision * interval '1 hour')`, [hours]);
  }

  async completeAutomationJob(jobId, log) {
    return this.transaction(async (tx) => {
      const existingLogs = await tx.query(
        "select id from automation_logs where event_key = $1 limit 1",
        [log.event_key]
      );
      if (existingLogs.length === 0) {
        await tx.query(
          `
            insert into automation_logs (booking_id, automation_name, event_key, result)
            values ($1, $2, $3, $4)
          `,
          [log.booking_id, log.automation_name, log.event_key, log.result]
        );
      }

      const rows = await tx.query(
        `
          update automation_jobs
          set status = 'completed',
              last_error = null
          where id = $1
          returning *
        `,
        [jobId]
      );
      return rows[0] ?? null;
    });
  }

  async getAutomationJobForUpdate(id) {
    const rows = await this.query("select * from automation_jobs where id = $1 for update", [id]);
    return rows[0] ?? null;
  }

  async hasAutomationLog(key) {
    const rows = await this.query("select 1 from automation_logs where event_key = $1", [key]);
    return rows.length > 0;
  }

  async cancelAutomationJob(id) {
    await this.query("update automation_jobs set status = 'cancelled' where id = $1", [id]);
  }

  async failAutomationJob(jobId, message, now = new Date()) {
    const config = require("../config").getBookingConfig();
    const rows = await this.query(
      `
        update automation_jobs
        set status = 'failed',
            last_error = $2,
            scheduled_at = $3::timestamptz + (least(3600, $4 * power(2, least(attempts - 1, 20))) * interval '1 second'),
            dead_lettered_at = case when attempts >= $5 then $3::timestamptz else null end
        where id = $1
        returning *
      `,
      [jobId, message, now, config.automationRetryBaseSeconds, config.automationMaxAttempts]
    );
    return rows[0] ?? null;
  }

  async listAutomationJobsForBooking(bookingId) {
    return this.query(
      `
        select *
        from automation_jobs
        where booking_id = $1
        order by created_at, scheduled_at
      `,
      [bookingId]
    );
  }

  async listConfirmedBookingsPastNoShowCutoff(cutoff) {
    return this.query(
      `
        select *
        from bookings
        where status = 'confirmed'
          and start_at < $1
        order by start_at
      `,
      [cutoff]
    );
  }

  async listBookingsForAutomationReconciliation() {
    return this.query(
      `
        select *
        from bookings
        where (
          status = 'confirmed'
          and not exists (
            select 1
            from automation_jobs
            where automation_jobs.booking_id = bookings.id
              and automation_jobs.automation_type in ('booking_confirmation', 'appointment_reminder')
              and automation_jobs.status in ('pending', 'processing', 'completed', 'failed')
          )
        )
        or (
          status = 'cancelled'
          and not exists (
            select 1
            from automation_jobs
            where automation_jobs.booking_id = bookings.id
              and automation_jobs.automation_type = 'booking_cancellation'
          )
        )
        or (
          status = 'no_show'
          and not exists (
            select 1
            from automation_jobs
            where automation_jobs.booking_id = bookings.id
              and automation_jobs.automation_type = 'no_show_followup'
          )
        )
        or (
          status = 'completed'
          and not exists (
            select 1
            from automation_jobs
            where automation_jobs.booking_id = bookings.id
              and automation_jobs.automation_type = 'post_service_followup'
          )
        )
        order by updated_at
        limit 100
      `
    );
  }

  // =========================================================================
  // Phase A1: Business Hours, Closures, Staff Schedules & Booking Settings
  // =========================================================================

  async listBusinessHours(businessId = "default") {
    return this.query(
      "select * from business_hours where business_id = $1 order by day_of_week asc",
      [businessId]
    );
  }

  async upsertBusinessHours(businessId = "default", hoursList = []) {
    return this.transaction(async (tx) => {
      const results = [];
      for (const h of hoursList) {
        const rows = await tx.query(
          `insert into business_hours (business_id, day_of_week, is_open, open_time, close_time)
           values ($1, $2, $3, $4, $5)
           on conflict (business_id, day_of_week)
           do update set is_open = excluded.is_open, open_time = excluded.open_time, close_time = excluded.close_time, updated_at = now()
           returning *`,
          [businessId, h.day_of_week, h.is_open !== false, h.open_time || "10:00", h.close_time || "19:00"]
        );
        if (rows[0]) results.push(rows[0]);
      }
      return results;
    });
  }

  async listBusinessClosures(businessId = "default", fromDate = null, toDate = null) {
    const conditions = ["business_id = $1"];
    const params = [businessId];
    if (fromDate && toDate) {
      params.push(fromDate, toDate);
      conditions.push(`date between $${params.length - 1} and $${params.length}`);
    } else if (fromDate) {
      params.push(fromDate);
      conditions.push(`date = $${params.length}`);
    }
    return this.query(
      `select *, date as closure_date, is_full_day as is_all_day from business_closures where ${conditions.join(" and ")} order by date asc, start_time asc nulls first`,
      params
    );
  }

  async createBusinessClosure(arg1, arg2) {
    const businessId = arg2 && typeof arg2 === "object" ? arg1 : (arg1?.business_id || "default");
    const data = arg2 && typeof arg2 === "object" ? arg2 : arg1;
    const dateVal = data.closure_date || data.date;
    const isFullDay = data.is_full_day === true || data.is_all_day === true || (!data.start_time && !data.end_time);
    const rows = await this.query(
      `insert into business_closures (business_id, date, start_time, end_time, is_full_day, reason)
       values ($1, $2, $3, $4, $5, $6)
       returning *, date as closure_date, is_full_day as is_all_day`,
      [
        businessId,
        dateVal,
        data.start_time || null,
        data.end_time || null,
        isFullDay,
        data.reason || null
      ]
    );
    return rows[0];
  }

  async deleteBusinessClosure(arg1, arg2 = "default") {
    const isFirstUuid = typeof arg1 === "string" && /^[0-9a-f-]{36}$/i.test(arg1);
    const id = isFirstUuid ? arg1 : arg2;
    const businessId = isFirstUuid ? (arg2 || "default") : arg1;
    const rows = await this.query(
      "delete from business_closures where business_id = $1 and id = $2 returning id",
      [businessId, id]
    );
    return rows.length > 0;
  }

  async listStaffSchedules(businessId = "default", staffId = null) {
    if (staffId) {
      return this.query(
        "select * from staff_schedules where business_id = $1 and staff_id = $2 order by day_of_week asc",
        [businessId, staffId]
      );
    }
    return this.query(
      "select * from staff_schedules where business_id = $1 order by staff_id asc, day_of_week asc",
      [businessId]
    );
  }

  async upsertStaffSchedule(businessId = "default", scheduleList = []) {
    return this.transaction(async (tx) => {
      const results = [];
      for (const s of scheduleList) {
        const rows = await tx.query(
          `insert into staff_schedules (business_id, staff_id, day_of_week, start_time, end_time, is_working)
           values ($1, $2, $3, $4, $5, $6)
           on conflict (business_id, staff_id, day_of_week)
           do update set is_working = excluded.is_working, start_time = excluded.start_time, end_time = excluded.end_time, updated_at = now()
           returning *`,
          [businessId, s.staff_id, s.day_of_week, s.start_time || "10:00", s.end_time || "19:00", s.is_working !== false]
        );
        if (rows[0]) results.push(rows[0]);
      }
      return results;
    });
  }

  async listStaffTimeOff(businessId = "default", dateOrFrom = null, staffIdOrTo = null) {
    const conditions = ["business_id = $1"];
    const params = [businessId];
    if (dateOrFrom) {
      params.push(dateOrFrom);
      conditions.push(`date = $${params.length}`);
    }
    if (staffIdOrTo) {
      params.push(staffIdOrTo);
      conditions.push(`staff_id = $${params.length}`);
    }
    return this.query(
      `select *, date as start_date, date as end_date, is_full_day as is_all_day from staff_time_off where ${conditions.join(" and ")} order by date asc, start_time asc nulls first`,
      params
    );
  }

  async createStaffTimeOff(arg1, arg2) {
    const businessId = arg2 && typeof arg2 === "object" ? arg1 : (arg1?.business_id || "default");
    const data = arg2 && typeof arg2 === "object" ? arg2 : arg1;
    const dateVal = data.start_date || data.date;
    const isFullDay = data.is_full_day === true || data.is_all_day === true || (!data.start_time && !data.end_time);
    const rows = await this.query(
      `insert into staff_time_off (business_id, staff_id, date, start_time, end_time, is_full_day, reason)
       values ($1, $2, $3, $4, $5, $6, $7)
       returning *, date as start_date, date as end_date, is_full_day as is_all_day`,
      [
        businessId,
        data.staff_id,
        dateVal,
        data.start_time || null,
        data.end_time || null,
        isFullDay,
        data.reason || null
      ]
    );
    return rows[0];
  }

  async deleteStaffTimeOff(arg1, arg2 = "default") {
    const isFirstUuid = typeof arg1 === "string" && /^[0-9a-f-]{36}$/i.test(arg1);
    const id = isFirstUuid ? arg1 : arg2;
    const businessId = isFirstUuid ? (arg2 || "default") : arg1;
    const rows = await this.query(
      "delete from staff_time_off where business_id = $1 and id = $2 returning id",
      [businessId, id]
    );
    return rows.length > 0;
  }

  async getBusinessBookingSettings(businessId = "default") {
    const rows = await this.query(
      "select * from business_booking_settings where business_id = $1",
      [businessId]
    );
    if (!rows[0]) return null;
    const s = rows[0];
    return {
      ...s,
      lead_time_minutes: s.booking_min_lead_minutes,
      booking_min_lead_minutes: s.booking_min_lead_minutes,
      max_advance_days: s.max_advance_booking_days,
      max_advance_booking_days: s.max_advance_booking_days
    };
  }

  async updateBusinessBookingSettings(businessId = "default", settings = {}) {
    const lead = settings.lead_time_minutes ?? settings.booking_min_lead_minutes ?? 15;
    const interval = settings.slot_interval_minutes ?? 15;
    const maxDays = settings.max_advance_days ?? settings.max_advance_booking_days ?? 60;
    const rows = await this.query(
      `insert into business_booking_settings (business_id, booking_min_lead_minutes, slot_interval_minutes, max_advance_booking_days)
       values ($1, $2, $3, $4)
       on conflict (business_id)
       do update set booking_min_lead_minutes = excluded.booking_min_lead_minutes,
                     slot_interval_minutes = excluded.slot_interval_minutes,
                     max_advance_booking_days = excluded.max_advance_booking_days,
                     updated_at = now()
       returning *`,
      [businessId, lead, interval, maxDays]
    );
    const s = rows[0];
    return {
      ...s,
      lead_time_minutes: s.booking_min_lead_minutes,
      booking_min_lead_minutes: s.booking_min_lead_minutes,
      max_advance_days: s.max_advance_booking_days,
      max_advance_booking_days: s.max_advance_booking_days
    };
  }
}

function getDatabaseUrl(env = process.env) {
  const url = env.DATABASE_URL ?? env.SUPABASE_DB_URL ?? env.POSTGRES_URL;
  if (!url) {
    throw new Error("DATABASE_URL is required for server database access");
  }
  return url;
}

function readSslConfig(options) {
  if (options.ssl !== undefined) {
    return options.ssl;
  }
  if (process.env.PGSSL === "false") {
    return false;
  }
  if (process.env.NODE_ENV === "production" || process.env.SUPABASE_DB_URL) {
    return { rejectUnauthorized: false };
  }
  return false;
}


module.exports = {
  PgBookingRepository,
  PgPaymentRepository: PgBookingRepository,
  normalizePgError
};

