-- แผนผังสนาม/โต๊ะ/ห้อง: where each court, table or room sits on a simple grid, so the customer sees the
-- venue at a glance and taps a free one. Optional: a shop that sets no positions shows the list as before.
-- IMPORTANT: run on booking-v2 BEFORE deploying the code that reads these columns.
-- Rerunnable. Existing RLS on public.resources applies unchanged (owner writes, members read, anon none).
begin;

alter table public.resources add column if not exists layout_row smallint;
alter table public.resources add column if not exists layout_col smallint;
alter table public.resources add column if not exists layout_w smallint not null default 1;
alter table public.resources add column if not exists layout_h smallint not null default 1;

alter table public.resources drop constraint if exists resources_layout_check;
alter table public.resources add constraint resources_layout_check check (
  ((layout_row is null) = (layout_col is null))
  and (layout_row is null or (layout_row between 1 and 12 and layout_col between 1 and 12))
  and layout_w between 1 and 6 and layout_h between 1 and 6
  and (layout_row is null or (layout_row + layout_h - 1 <= 12 and layout_col + layout_w - 1 <= 12))
);

comment on column public.resources.layout_row is 'แผนผัง: แถวบนสุดที่ช่องนี้อยู่ (1–12) · null = ไม่อยู่บนผัง';
comment on column public.resources.layout_col is 'แผนผัง: คอลัมน์ซ้ายสุด (1–12)';
comment on column public.resources.layout_w is 'แผนผัง: กว้างกี่ช่อง (1–6)';
comment on column public.resources.layout_h is 'แผนผัง: สูงกี่ช่อง (1–6)';

commit;
