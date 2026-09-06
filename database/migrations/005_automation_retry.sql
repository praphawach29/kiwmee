begin;
alter table automation_jobs add column if not exists dead_lettered_at timestamptz;
create index if not exists idx_automation_dead_letter on automation_jobs(dead_lettered_at)
where dead_lettered_at is not null;
commit;
