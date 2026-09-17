-- Режим ввода привязывается к конкретному чату: нажатие «Добавить» в группе
-- не должно перехватывать сообщения в личке и наоборот.
alter table user_state add column if not exists chat_id bigint;

-- Одноразовый режим: применяется к одному следующему сообщению и гаснет.
-- В группе только так — иначе кнопка захватывает общую переписку.
alter table user_state add column if not exists one_shot boolean not null default false;
