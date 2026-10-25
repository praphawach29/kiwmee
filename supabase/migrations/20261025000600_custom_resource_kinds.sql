-- Flexible booking v2: shops name their own kinds of resource ("เก้าอี้นวด", "โต๊ะสนุ๊ก", "ห้องคาราโอเกะ")
-- instead of only staff / court / room / equipment. The kind is just a label that an offering's
-- requirement matches on (offering_requirements.kind = resources.kind); nothing else depends on the
-- four built-in values, so any short text works. The admin page still offers the four by default.

alter table public.resources drop constraint if exists resources_kind_check;
alter table public.resources add constraint resources_kind_check
  check (kind = trim(kind) and length(kind) between 1 and 40);

alter table public.offering_requirements drop constraint if exists offering_requirements_kind_check;
alter table public.offering_requirements add constraint offering_requirements_kind_check
  check (kind = trim(kind) and length(kind) between 1 and 40);
