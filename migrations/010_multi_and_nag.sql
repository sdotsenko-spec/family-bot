-- Долбящие напоминания: «висеть весь день, пока не отмечу».
-- Обычные напоминания привязаны к сроку и заканчиваются вместе с ним,
-- а тут нужен повтор в окне времени до тех пор, пока задачу не закроют.
alter table tasks add column if not exists nag_every_min int;
alter table tasks add column if not exists nag_from time;
alter table tasks add column if not exists nag_to time;

-- Разбор, ожидающий подтверждения: когда из одной фразы вышло несколько задач,
-- сначала показываем предпросмотр. Держим в БД, а не в памяти процесса,
-- чтобы подтверждение пережило передеплой.
create table if not exists pending_parses (
  id         serial primary key,
  user_id    int references users(id) on delete cascade,
  chat_id    bigint,
  thread_id  int,
  raw_input  text not null,
  payload    jsonb not null,
  is_private boolean not null default false,
  created_at timestamptz not null default now()
);

-- Сколько сообщений бот отправил человеку за день — для потолка навязчивости
create index if not exists reminders_sent_day_idx on reminders (sent_at) where status = 'sent';
