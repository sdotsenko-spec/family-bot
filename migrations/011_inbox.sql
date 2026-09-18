-- Задачи без срока. Раньше дата была обязательной, и дело «когда-нибудь»
-- получало завтрашнее утро, к обеду считалось просроченным и уходило
-- в эскалацию. Теперь такие задачи просто висят.
alter table tasks alter column due_at drop not null;
alter table tasks add column if not exists is_inbox boolean not null default false;

create index if not exists tasks_inbox_idx on tasks (is_inbox, status) where status = 'pending';
