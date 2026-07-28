import { InlineKeyboard } from 'grammy';
import { q, withTx } from './db.js';
import { offsetToMs, humanOffset, fmt, TZ } from './time.js';

export const DEFAULT_OFFSETS = ['24h', '3h', '30m'];

// Если бот лежал и напоминание протухло больше чем на GRACE_MS — не отправляем,
// помечаем skipped. Иначе после каждого деплоя семья получает пачку мусора.
const GRACE_MS = Number(process.env.REMINDER_GRACE_MIN || 120) * 60_000;

// Через сколько после дедлайна пинговать в общий чат, если задачу не закрыли.
const ESCALATE_AFTER_MS = Number(process.env.ESCALATE_AFTER_MIN || 30) * 60_000;
const ESCALATION_ENABLED = process.env.ESCALATION !== 'off';

/**
 * Пересобирает напоминания задачи.
 * Уже отправленные (sent) не трогаем — только pending/sending.
 * Прошедшие моменты не создаём: задача на через час не должна
 * мгновенно выстрелить напоминанием «за сутки».
 */
export async function regenerateReminders(taskOrId, client = null) {
  const runner = client ? (t, p) => client.query(t, p) : q;

  const task =
    typeof taskOrId === 'object'
      ? taskOrId
      : (await runner('select * from tasks where id = $1', [taskOrId])).rows[0];
  if (!task) return 0;

  await runner(
    `delete from reminders where task_id = $1 and status in ('pending','sending')`,
    [task.id]
  );

  if (task.status !== 'pending') return 0;

  const due = new Date(task.due_at).getTime();
  const now = Date.now();
  const labels = Array.isArray(task.offsets) ? task.offsets : DEFAULT_OFFSETS;

  const rows = [];
  for (const label of labels) {
    const ms = offsetToMs(label);
    if (ms == null) continue;
    const fireAt = due - ms;
    if (fireAt <= now) continue;
    rows.push([task.id, label, new Date(fireAt)]);
  }

  // Само наступление срока — тоже напоминание.
  if (due > now) rows.push([task.id, 'due', new Date(due)]);

  if (ESCALATION_ENABLED && due + ESCALATE_AFTER_MS > now) {
    rows.push([task.id, 'escalation', new Date(due + ESCALATE_AFTER_MS)]);
  }

  for (const [taskId, label, fireAt] of rows) {
    await runner(
      `insert into reminders(task_id, label, fire_at) values ($1,$2,$3)
       on conflict (task_id, label) do update set fire_at = excluded.fire_at, status='pending'`,
      [taskId, label, fireAt]
    );
  }
  return rows.length;
}

export async function cancelReminders(taskId, client = null) {
  const runner = client ? (t, p) => client.query(t, p) : q;
  await runner(
    `update reminders set status='cancelled'
     where task_id = $1 and status in ('pending','sending')`,
    [taskId]
  );
}

/**
 * Атомарно забирает пачку созревших напоминаний.
 * FOR UPDATE SKIP LOCKED — чтобы два инстанса (или тикер, наехавший сам на себя)
 * не отправили одно и то же дважды.
 */
async function claimDue(limit = 25) {
  const { rows } = await q(
    `update reminders r
        set status = 'sending', attempts = r.attempts + 1
      where r.id in (
        select id from reminders
         where status = 'pending' and fire_at <= now()
         order by fire_at
         limit $1
         for update skip locked
      )
      returning r.*`,
    [limit]
  );
  return rows;
}

function buildKeyboard(task) {
  return new InlineKeyboard()
    .text('✅ Готово', `done:${task.id}`)
    .text('⏰ +1 час', `snooze:${task.id}:60`)
    .row()
    .text('📅 Завтра', `tomorrow:${task.id}`)
    .text('🙅 Не я', `notmine:${task.id}`);
}

function mention(user) {
  if (!user) return '';
  if (user.tg_username) return `@${user.tg_username}`;
  return `<a href="tg://user?id=${user.tg_user_id}">${escapeHtml(user.name || 'кто-то')}</a>`;
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function renderText(reminder, task, assignee) {
  const when = fmt(new Date(task.due_at), task.tz || TZ, task.is_all_day);
  const who = assignee ? ` — ${mention(assignee)}` : '';
  const head =
    reminder.label === 'escalation'
      ? '‼️ <b>Просрочено</b>'
      : reminder.label === 'due'
        ? '🔔 <b>Пора</b>'
        : `⏳ <b>Напоминание ${humanOffset(reminder.label)}</b>`;

  const src = task.source !== 'bot' ? `\n<i>из календаря</i>` : '';
  const notes = task.notes ? `\n${escapeHtml(task.notes)}` : '';

  return `${head}\n\n<b>${escapeHtml(task.title)}</b>${who}\n🗓 ${when}${notes}${src}`;
}

/**
 * Один проход диспетчера. Вызывается тикером раз в минуту.
 */
export async function dispatchDueReminders(bot) {
  const due = await claimDue();
  if (!due.length) return 0;

  const familyChatRaw = process.env.FAMILY_CHAT_ID;
  let sent = 0;

  for (const reminder of due) {
    try {
      const { rows } = await q(
        `select t.*, u.tg_user_id, u.tg_username, u.name as assignee_name, u.dm_chat_id
           from tasks t left join users u on u.id = t.assignee_id
          where t.id = $1`,
        [reminder.task_id]
      );
      const task = rows[0];

      if (!task || task.status !== 'pending') {
        await q(`update reminders set status='cancelled' where id = $1`, [reminder.id]);
        continue;
      }

      // Протухло — молча пропускаем
      if (Date.now() - new Date(reminder.fire_at).getTime() > GRACE_MS) {
        await q(`update reminders set status='skipped' where id = $1`, [reminder.id]);
        console.warn(`[reminders] skipped #${reminder.id} (task ${task.id}) — вне grace-окна`);
        continue;
      }

      const assignee = task.assignee_id
        ? {
            tg_user_id: task.tg_user_id,
            tg_username: task.tg_username,
            name: task.assignee_name,
          }
        : null;

      // Эскалация всегда идёт в общий чат, обычные — туда, где задачу создали.
      const chatId =
        reminder.label === 'escalation'
          ? familyChatRaw || task.chat_id
          : task.chat_id || familyChatRaw;

      if (!chatId) {
        await q(`update reminders set status='skipped' where id = $1`, [reminder.id]);
        continue;
      }

      const msg = await bot.api.sendMessage(chatId, renderText(reminder, task, assignee), {
        parse_mode: 'HTML',
        message_thread_id: task.thread_id || undefined,
        reply_markup: buildKeyboard(task),
        link_preview_options: { is_disabled: true },
      });

      await q(
        `update reminders set status='sent', sent_at=now(), tg_message_id=$2 where id = $1`,
        [reminder.id, msg.message_id]
      );
      sent++;

      // Мягкий троттлинг: Telegram не любит >~20 сообщений в секунду
      await new Promise((r) => setTimeout(r, 120));
    } catch (e) {
      console.error(`[reminders] ошибка отправки #${reminder.id}:`, e.message);
      // Возвращаем в очередь, но не бесконечно
      await q(
        `update reminders
            set status = case when attempts >= 3 then 'skipped' else 'pending' end
          where id = $1`,
        [reminder.id]
      );
    }
  }
  return sent;
}

/** Отметить выполненной и погасить остальные напоминания. */
export async function completeTask(taskId, userId) {
  return withTx(async (c) => {
    const { rows } = await c.query(
      `update tasks set status='done', done_at=now(), done_by=$2, updated_at=now()
        where id=$1 and status='pending' returning *`,
      [taskId, userId || null]
    );
    if (!rows.length) return null;
    await c.query(
      `update reminders set status='cancelled' where task_id=$1 and status in ('pending','sending')`,
      [taskId]
    );
    return rows[0];
  });
}

/** Сдвинуть срок и пересобрать напоминания. */
export async function rescheduleTask(taskId, newDue) {
  return withTx(async (c) => {
    const { rows } = await c.query(
      `update tasks set due_at=$2, updated_at=now() where id=$1 returning *`,
      [taskId, newDue]
    );
    if (!rows.length) return null;
    await regenerateReminders(rows[0], c);
    return rows[0];
  });
}
