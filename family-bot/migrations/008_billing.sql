-- Начисления коммуналки. Одна строка — одна позиция в платёжке.
--   kind='metered' — цена × расход по счётчику
--   kind='fixed'   — фиксированная сумма (абонплата, квартплата)
--
-- Тарифы меняются, поэтому цена хранится с датой начала действия:
-- строк на одну позицию может быть несколько, берётся актуальная на период.
create table if not exists charges (
  id         serial primary key,
  provider   text not null,                     -- 'Киевводоканал'
  name       text not null,                     -- 'Постачання ХВ'
  kind       text not null,                     -- 'metered' | 'fixed'
  meter_id   int references meters(id) on delete set null,
  rate       numeric(14,4) not null,
  valid_from date not null default current_date,
  position   int not null default 0,
  active     boolean not null default true,
  created_at timestamptz not null default now()
);

create index if not exists charges_lookup_idx on charges (provider, name, valid_from desc);

-- Посчитанные счета — чтобы сравнивать периоды между собой
create table if not exists bills (
  id           serial primary key,
  period_start timestamptz not null,
  period_end   timestamptz not null,
  total        numeric(14,2) not null,
  breakdown    jsonb not null,
  created_at   timestamptz not null default now()
);

create index if not exists bills_period_idx on bills (period_end desc);
