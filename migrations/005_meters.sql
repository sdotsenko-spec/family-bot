-- Счётчики и их показания. Отдельно от задач: задача напоминает снять,
-- а хранение цифр и расчёт расхода — самостоятельная сущность.
create table if not exists meters (
  id         serial primary key,
  name       text not null,
  unit       text not null default '',
  position   int not null default 0,     -- порядок при вводе списком
  active     boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists meter_readings (
  id        serial primary key,
  meter_id  int not null references meters(id) on delete cascade,
  value     numeric(14,3) not null,
  taken_at  timestamptz not null default now(),
  added_by  int references users(id) on delete set null
);

create index if not exists meter_readings_idx on meter_readings (meter_id, taken_at desc);
