# Booking templates and add-ons — proposed architecture

Status: incremental design. Existing appointment/slot engine is retained. Rental, add-on inventory, gallery persistence and template version persistence are NOT implemented by this document.

## Product rule
Choose a service template to obtain suitable defaults, labels, steps and modules. A template is not merely a colour theme and never grants backend capabilities. Business category (salon/court/other) is distinct from booking mode. Do not promise support for every service: unusual workflows require explicit capability assessment.

## Shared presentation
Kiwmee Grape/Mint, Mitr/Anuphan, cover gallery with thumbnails when real media exists; accessible brand placeholder otherwise. Calendar/compact dates, resource cards, quantity picker, optional add-on stage, editable summary, persistent mobile action bar with safe-area spacing. No fake reviews, availability, discounts, prices or imagery attributed to a business.

UI order follows the server engine's flow, not a universal hard-coded wizard. Unavailable slots include text reasons. Server validates all steps again on confirmation. Never say confirmed until server reports status; distinguish pending, held and confirmed.

## Template families
| ID | Example | Availability model | State |
|---|---|---|---|
| appointment | hair, spa, private lesson | service duration + staff/room interval | map to existing flow after capability checks |
| resource_slot | court, rehearsal/meeting room | chosen asset + duration + start time | map only when existing offering/resource configuration fits |
| capacity_session | class, workshop | scheduled availability + capacity/party count | existing capacity engine only; not recurring-course enrolment |
| rental_range | car, camera, equipment | pickup/return timestamps + asset/stock occupancy | future backend; do not allow activation |
| service_visit | cleaning, repair, on-site work | address/service zone + travel + workers | future backend; do not allow activation |
| multi_day_stay | accommodation | night boundaries + room inventory + occupancy rules | future; not interchangeable with 24-hour rental |

Consultations can use appointment when time/staff semantics fit; online session links are separate delivery integration. Tables/restaurants can use capacity only if seating/time/turnover actually match; table allocation is not assumed. Multi-service carts, packages, recurring reservations, courses and transport routes are separate extensions, not a template label claiming implementation.

## Owner setup flow
1. Choose booking family; explain suitable businesses and limitations.
2. Show compatibility checks on current services/resources.
3. Preview resulting sequence and labels, keep existing settings unchanged.
4. Explicitly apply defaults to a draft; allow restoring previous draft.
5. Save through existing owner-authorized endpoint (no hidden writes).
6. Future media/module settings use separate migrations, validations and preview.

Initial implementation is a flow preset selector, not persisted template identity. Future persisted config: template_id + template_version + validated overrides. Snapshots/versioning prevent later template edits silently changing existing shops. Changing templates must not rewrite services, prices, resources or booked appointments.

## Capability modules
- media: cover + ordered gallery + alt text; owner uploads validated image MIME/size; tenant-scoped storage policies; no arbitrary server URL fetching; remove metadata where appropriate.
- staff/resource choice; fixed/flexible duration; party size/capacity.
- timestamp range; pickup/return locations; service zones; nightly/24-hour billing.
- add-ons; quantity; scarce stock; worker allocation.
- payment/deposit; cancellation; customer fields with data minimization.
Each module needs UI, server validation and tests before enabled. Unsupported modules stay unavailable, not decorative controls.

## Add-on domain (future schema, not migration)
Definitions scoped to business and permitted offerings. Fields: name, description, active, selection group (one/many), required, min/max quantity, price mode (once/per-hour/per-24h/per-night/per-person/per-unit), amount, currency, inventory/worker reference, occupancy scope, additional duration and compatibility rules.

Distinguish option with unlimited capacity (fuel package), scarce item (child seat, racket), allocated worker (driver), delivery trip, and service extension (extra treatment time). Required groups need server validation; dependencies/exclusions form a validated acyclic graph. Price in minor currency units, no client-authoritative totals. Do not use a single generic JSON blob as the booking's only financial/inventory record.

Booking selection snapshots preserve label, quantity, unit price, calculation basis, taxes/fees and policy version. Historical bookings never change when catalogue prices change. Add-on reservations reference actual resource/stock allocations.

## Pricing and time
Store UTC timestamps plus business timezone. Use half-open occupancy [start,end), include prep/cleanup/turnaround buffers. Clearly define 24h vs calendar day vs night; validate return after pickup, same-day rental, late return and timezone/DST. Rate quotes expire; on changes re-quote and explain changed price. Optional extras and refundable security deposits are distinct line items, not conflated revenue. Explicitly show amount due now, later and refundable amount; payment terms must exist before showing payment CTA.

## Availability and transaction boundaries
Compute base asset AND add-on/worker availability across full occupied interval. Shared add-on inventory may span several services/shops only with explicit authorized scope. Atomic hold of all required allocations in one transaction, expiry and release, concurrency-safe capacity checks, idempotent booking/payment requests. No partial success (car confirmed but driver missing). Reschedule recalculates allocations/prices and atomically swaps; cancellation/expiry releases all holds. Payment webhooks reconcile safely and reject duplicate effects. Never rely on UI filtering as isolation.

## Roles and tenant isolation
Owner configures own shop; staff only existing authorized operations; customer sees own booking via established verified identity/token; super support writes deferred until scoped authorization + audit. Every new tenant table needs RLS, exact business/brand ownership verification, grants and cross-tenant tests. Global templates contain no tenant data. API rejects cross-shop offering/add-on/resource IDs even if valid UUIDs.

## Delivery slices
A. Existing engine mobile visual polish + capability-tested preset selector; no schema changes.
B. Real media gallery CRUD/storage + persisted versioned template config (new migration, owner/RLS tests, full SQL for Jack before merge).
C. Add-on pricing definitions and immutable booking line snapshots; launch only with atomic inventory/worker handling where required.
D. Rental timestamp-range engine + holds, stock, deposit and rescheduling. Test overlap races, multi-day periods, boundary times, price rounding and cancellations.
E. On-site/stay/recurrence only after dedicated requirements and tests.

Acceptance gates: mobile 360/390/430px + tablet/desktop, keyboard focus and errors, image failure fallback, no obscured final content under CTA, date-first/service-first, staff/resources/duration/party combinations, concurrent availability, tenant isolation, quote consistency and compatibility with existing bookings.
