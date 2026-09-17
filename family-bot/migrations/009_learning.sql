-- Исходная фраза задачи. Без неё нечему учиться: после правки видно только
-- итог, а нужна пара «как написал» → «что имелось в виду».
alter table tasks add column if not exists raw_input text;

-- Примеры разбора, накопленные из исправлений через карандаш.
-- now_at — момент, когда фраза была написана: без него «завтра» в примере
-- разъедется относительно даты.
create table if not exists parse_examples (
  id         serial primary key,
  input      text not null,
  now_at     timestamptz not null,
  result     jsonb not null,
  created_by int references users(id) on delete set null,
  active     boolean not null default true,
  created_at timestamptz not null default now()
);

create unique index if not exists parse_examples_input_uniq on parse_examples (lower(input));
