-- Личные задачи: созданные в личке с ботом. Такие не должны попадать
-- ни в семейный дайджест, ни в эскалацию в общий чат.
alter table tasks add column if not exists is_private boolean not null default false;
alter table recurrences add column if not exists is_private boolean not null default false;

-- Задним числом: всё, что создавалось в личных чатах, помечаем личным
update tasks set is_private = true
 where is_private = false
   and chat_id in (select dm_chat_id from users where dm_chat_id is not null);

update recurrences set is_private = true
 where is_private = false
   and chat_id in (select dm_chat_id from users where dm_chat_id is not null);
