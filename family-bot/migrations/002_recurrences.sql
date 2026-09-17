-- Повторяющиеся задачи, созданные в самом боте (не из календаря).
-- Хранится правило, а не отдельные вхождения; конкретные задачи
-- материализуются фоновым джобом на горизонт вперёд.
create table if not exists recurrences (
  id                 serial primary key,
  title              text not null,
  notes              text,
  rrule              text not null,          -- 'FREQ=WEEKLY;BYDAY=TU'
  dtstart            timestamptz not null,   -- первая точка, задаёт время суток
  tz                 text not null default 'Europe/Kyiv',
  is_all_day         boolean not null default false,
  assignee_id        int references users(id) on delete set null,
  creator_id         int references users(id) on delete set null,
  chat_id            bigint,
  thread_id          int,
  offsets            jsonb not null default '["24h","3h","30m"]'::jsonb,
  -- BYMONTHDAY=29..31 в коротких месяцах RRULE просто пропускает.
  -- С этим флагом вместо пропуска берём последний день месяца.
  month_end_fallback boolean not null default true,
  active             boolean not null default true,
  last_run_at        timestamptz,
  created_at         timestamptz not null default now()
);

alter table tasks
  add column if not exists recurrence_id int references recurrences(id) on delete cascade;

create index if not exists tasks_recurrence_idx on tasks (recurrence_id);
