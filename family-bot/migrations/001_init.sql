-- Пользователи семьи. Заполняется по /start.
create table if not exists users (
  id           serial primary key,
  tg_user_id   bigint unique not null,
  tg_username  text,
  name         text,
  dm_chat_id   bigint,                 -- личка, если человек написал /start боту в ЛС
  tz           text not null default 'Europe/Kyiv',
  created_at   timestamptz not null default now()
);

-- Глобальные настройки (id семейного чата, топики, дата последнего дайджеста и т.п.)
create table if not exists settings (
  key   text primary key,
  value jsonb not null
);

-- Подключённые календари (пока kind='ics'; для Google добавится 'gcal')
create table if not exists calendars (
  id           serial primary key,
  owner_id     int references users(id) on delete cascade,
  kind         text not null default 'ics',
  url          text not null unique,
  label        text,
  last_sync_at timestamptz,
  last_error   text,
  active       boolean not null default true,
  created_at   timestamptz not null default now()
);

-- Задачи: и созданные в боте, и импортированные из календарей
create table if not exists tasks (
  id               serial primary key,
  title            text not null,
  notes            text,
  due_at           timestamptz not null,
  is_all_day       boolean not null default false,
  tz               text not null default 'Europe/Kyiv',
  assignee_id      int references users(id) on delete set null,
  creator_id       int references users(id) on delete set null,
  chat_id          bigint,             -- куда слать напоминания
  thread_id        int,                -- топик внутри группы (nullable)
  source           text not null default 'bot',   -- bot | ics | gcal | caldav
  calendar_id      int references calendars(id) on delete cascade,
  external_id      text,               -- UID события в календаре
  occurrence_start timestamptz,        -- конкретное вхождение повторяющегося события
  etag             text,               -- отпечаток события, чтобы не пересоздавать напоминания зря
  status           text not null default 'pending',  -- pending | done | cancelled
  done_at          timestamptz,
  done_by          int references users(id) on delete set null,
  offsets          jsonb not null default '["24h","3h","30m"]'::jsonb,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

-- Идемпотентность импорта: одно вхождение одного события = одна задача
create unique index if not exists tasks_external_uniq
  on tasks (source, external_id, occurrence_start)
  where external_id is not null;

create index if not exists tasks_due_idx on tasks (due_at) where status = 'pending';

-- Материализованные напоминания. Никаких setTimeout в памяти.
create table if not exists reminders (
  id            serial primary key,
  task_id       int not null references tasks(id) on delete cascade,
  label         text not null,          -- '24h' | '3h' | '30m' | 'escalation'
  fire_at       timestamptz not null,
  status        text not null default 'pending', -- pending | sending | sent | skipped | cancelled
  sent_at       timestamptz,
  tg_message_id bigint,
  attempts      int not null default 0,
  unique (task_id, label)
);

create index if not exists reminders_due_idx on reminders (fire_at) where status = 'pending';
