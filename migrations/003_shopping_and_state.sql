-- Общий список покупок. Список один на семью — множественные списки
-- для домашнего использования избыточны.
create table if not exists shopping_items (
  id         serial primary key,
  title      text not null,
  added_by   int references users(id) on delete set null,
  checked    boolean not null default false,
  checked_by int references users(id) on delete set null,
  checked_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists shopping_open_idx on shopping_items (checked, created_at);

-- Короткоживущий режим ввода: следующее сообщение пользователя уходит
-- не в задачи, а в список покупок или в редактирование конкретной задачи.
-- В БД, а не в памяти процесса, чтобы режим переживал передеплой.
create table if not exists user_state (
  user_id    int primary key references users(id) on delete cascade,
  mode       text not null,        -- 'shopping' | 'edit'
  target_id  int,
  expires_at timestamptz not null
);
