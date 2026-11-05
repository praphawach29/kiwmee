# Upload images from a local device

## Setup gate
Run `supabase/migrations/20261025001500_shop_media_storage.sql` in **Kiwmee (`ezubgqeqdipwfnmorqkj`, formerly booking-v2) only** before merging this branch. Do not use the legacy v1 project. This creates/configures public bucket `shop-media` and owner-scoped Storage policies. Existing galleries need migration 001400 (already deployed).

No service-role key is needed. Railway uses the existing SUPABASE_URL plus SUPABASE_PUBLISHABLE_KEY (or legacy anon key) and the signed-in owner's JWT, including refreshed tokens. Upload runtime deliberately rejects other project URLs and secret/service-role keys.

## Scope
Both existing image editors (shop and each service) support multi-file JPEG/PNG/WebP selection, 5 MiB per file and 8 gallery entries total, previews, retry and per-file errors. Existing URL entry remains available. Files upload immediately; the gallery is persisted only by the existing explicit Save. Staff cannot upload. This does not add private booking attachments, slips, resource images, or a file picker to records that have no gallery schema.

Uploads are public marketing assets. Do not upload customer/private documents. Removing an entry only removes its gallery reference, not the stored public file. Deleting orphan files and lifecycle cleanup are not implemented; files from abandoned drafts remain stored. Do not use this for confidential material.

API validates size, MIME, magic and decoded image dimensions, rejects animated images, strips metadata through re-encoding to WebP and stores under a random UUID in the authorized business prefix. Supabase policies also prevent cross-shop upload and overwrites/deletion. Authorized owners may call Storage directly; its MIME/size/ownership restrictions apply, but API re-encoding cannot be guaranteed for direct Storage writes. The in-memory rate limit is per application instance, not a distributed quota.

## Verification
- Parent combined run: 370 passing tests, 90 skipped, zero failures; production build passed.
- Backend local DB report: 75 tests passed with Storage schema shim, including policy isolation and migration rerun. This is not a full Supabase Storage HTTP service.
- Parent Playwright: local production build at desktop 1440px/mobile 390px with explicitly mocked catalog/upload APIs; chooser, upload-draft, blocked submit during pending upload, explicit save, staff hiding and no horizontal overflow/JS errors passed.
- Actual authenticated Storage upload/readback in the Kiwmee project remains a post-migration/deployment verification gate. No production uploads or remote database changes were made by this work.
