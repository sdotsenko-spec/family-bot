-- Многотарифные счётчики: один прибор, несколько регистров (день/ночь/общий).
-- Группа — это сам прибор, name — регистр внутри него.
alter table meters add column if not exists group_name text;

-- Роль регистра: 'day' | 'night' | 'total' | null (обычный счётчик).
-- Нужна, чтобы проверять, что день + ночь сходятся с общим.
alter table meters add column if not exists role text;
