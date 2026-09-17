import { Bot, InlineKeyboard, Keyboard } from 'grammy';
import { q, withTx, getSetting, setSetting, setState, getStateByTg, clearState } from './db.js';
import { parseTask } from './parser.js';
import {
  regenerateReminders,
  completeTask,
  rescheduleTask,
  DEFAULT_OFFSETS,
} from './reminders.js';
import { DateTime, TZ, fmt, humanOffset } from './time.js';
import { syncAllCalendars } from './calendar/ics.js';
import {
  addItems,
  toggleItem,
  deleteItem,
  clearChecked,
  renderList,
  refreshMessage,
  looksLikeTask,
} from './shopping.js';
import { parseFallback } from './parser.js';
import { feedToken, publicUrl } from './feed.js';
import { saveExample, renderExamples, deactivateExample } from './learning.js';
import {
  computeBill,
  renderBill,
  saveBill,
  listCharges,
  updateRate,
  deactivateCharge,
  setupFromInvoices,
} from './billing.js';
import {
  isMeterTask,
  listMeters,
  addMeter,
  removeMeter,
  restoreMeter,
  listAllMeters,
  undoLastReading,
  readingsLog,
  removeReading,
  isImplausible,
  renderLog,
  displayName,
  extractNumbers,
  saveReadings,
  renderReport,
  renderSummary,
  renderPrompt,
  saveOneReading,
  extractDate,
  checkGroup,
  renderOne,
  metersKeyboard,
  addPreset,
} from './meters.js';
import {
  parseRecurrence,
  looksRecurring,
  describeRrule,
  materializeRecurrence,
  deactivateRecurrence,
  occurrencesBetween,
} from './recurrence.js';

export const bot = new Bot(process.env.TELEGRAM_BOT_TOKEN);

// Постоянная клавиатура под полем ввода. Только в личке: в группе она
// была бы общей на всех и мешала бы обычной переписке.
const mainKeyboard = new Keyboard()
  .text('🛒 Покупки')
  .text('📋 Сегодня')
  .row()
  .text('📆 Неделя')
  .text('🔁 Повторы')
  .row()
  .text('🏠 Дом')
  .resized();

const exitKeyboard = new Keyboard().text('✅ Выйти').resized();

const esc = (s) =>
  String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// --- пользователи -----------------------------------------------------------

async function upsertUser(from, chat) {
  const { rows } = await q(
    `insert into users (tg_user_id, tg_username, name, dm_chat_id, tz)
     values ($1,$2,$3,$4,$5)
     on conflict (tg_user_id) do update set
       tg_username = excluded.tg_username,
       name = excluded.name,
       dm_chat_id = coalesce(excluded.dm_chat_id, users.dm_chat_id)
     returning *`,
    [
      from.id,
      from.username || null,
      [from.first_name, from.last_name].filter(Boolean).join(' ') || from.username || 'без имени',
      chat?.type === 'private' ? chat.id : null,
      TZ,
    ]
  );
  return rows[0];
}

async function findUserByUsername(username) {
  if (!username) return null;
  const { rows } = await q('select * from users where lower(tg_username) = lower($1)', [username]);
  return rows[0] || null;
}

// --- рендер -----------------------------------------------------------------

function taskLine(t) {
  const mark =
    t.status === 'done' ? '✅' : t.source === 'recur' ? '🔁' : t.source !== 'bot' ? '🗓' : '•';
  const who = t.assignee_name ? ` — ${esc(t.assignee_name)}` : '';
  return `${mark} <b>${esc(t.title)}</b>${who}\n   ${fmt(new Date(t.due_at), t.tz || TZ, t.is_all_day)}  <code>#${t.id}</code>`;
}

function taskKeyboard(id, recurrenceId = null, title = '') {
  const kb = new InlineKeyboard()
    .text('✅ Готово', `done:${id}`)
    .text('⏰ Отложить', `snoozemenu:${id}`)
    .row();
  if (isMeterTask(title)) kb.text('📟 Внести показания', `meter_input:${id}`).row();
  kb.text('🗑 Удалить', `drop:${id}`).text('✏️ Изменить', `edit:${id}`);
  if (recurrenceId) kb.row().text('🚫 Отключить повтор', `drop_recur:${recurrenceId}`);
  return kb;
}

/** Подменю «Отложить»: раскрывается на месте, чтобы не плодить кнопки. */
function snoozeKeyboard(id) {
  return new InlineKeyboard()
    .text('1 час', `snooze:${id}:60`)
    .text('3 часа', `snooze:${id}:180`)
    .row()
    .text('Вечером', `snoozeto:${id}:evening`)
    .text('Завтра утром', `snoozeto:${id}:morning`)
    .row()
    .text('В выходные', `snoozeto:${id}:weekend`)
    .text('Через неделю', `snooze:${id}:10080`)
    .row()
    .text('← Назад', `snoozeback:${id}`);
}

/** Клавиатура под карточкой правила. */
function recurKeyboard(id) {
  return new InlineKeyboard().text('🚫 Отключить повтор', `drop_recur:${id}`);
}

// --- команды ----------------------------------------------------------------

bot.command('start', async (ctx) => {
  const user = await upsertUser(ctx.from, ctx.chat);
  await clearState(user.id); // на случай залипшего режима ввода
  if (ctx.chat.type !== 'private') {
    await setSetting('family_chat_id', ctx.chat.id);
    if (ctx.message.message_thread_id) {
      await setSetting('family_thread_id', ctx.message.message_thread_id);
    }
    return ctx.reply(
      `Готово, этот чат теперь семейный 👨‍👩‍👧\n` +
        `Задача создаётся сообщением, начинающимся с <b>+</b>:\n` +
        `<code>+завтра в 18:30 забрать посылку @${ctx.from.username || 'кто-то'}</code>\n\n` +
        `Каждому стоит один раз написать мне в личку /start — тогда смогу писать напрямую.`,
      { parse_mode: 'HTML' }
    );
  }
  return ctx.reply(
    `Привет, ${esc(user.name)}! Я домашний ассистент.\n\n` +
      `Просто пиши задачу текстом:\n` +
      `<code>завтра в 18:30 забрать посылку, напомни за сутки и за 2 часа</code>\n\n` +
      `Кнопки внизу — покупки и списки задач. Команды: /help`,
    { parse_mode: 'HTML', reply_markup: mainKeyboard }
  );
});

bot.command('help', (ctx) =>
  ctx.reply(
    `<b>Создать задачу</b>\nВ личке — просто текстом. В группе — сообщение с <b>+</b> в начале.\n` +
      `Понимаю: сегодня/завтра/послезавтра, «в среду», «5 августа», «12.08», «через 2 часа», ` +
      `«в 18:30», «вечером», «@username», «напомни за сутки и за 2 часа».\n\n` +
      `<b>Повторяющиеся</b>\n«каждый вторник в 20:00», «по будням», «по выходным», ` +
      `«каждое 29 число», «каждый предпоследний день месяца», «каждый первый понедельник месяца», ` +
      `«каждые 2 недели», «ежедневно».\n\n` +
      `<b>Ещё</b>\nОтветьте на чужое сообщение словом «+завтра в 18:00» — задача создастся из того сообщения.\n` +
      `В личке внизу есть кнопки: покупки, сегодня, неделя, повторы и «Дом».\n\n` +
      `<b>Команды</b>\n` +
      `/today — что сегодня\n/week — на неделю\n/list — все открытые\n` +
      `/done ID — закрыть\n/del ID — удалить\n/edit ID текст — изменить\n` +
      `/buy — список покупок\n/meter — счётчики и показания\n` +
      `/home — счётчики, коммуналка, тарифы\n/learned — чему бот научился\n` +
      `/calfeed — подписка на календарь\n` +
      `/recur — повторяющиеся задачи\n` +
      `/cal add URL — подключить календарь (ссылка .ics)\n` +
      `/cal list, /cal del ID\n/sync — синхронизировать календари сейчас\n` +
      `/tz — текущая таймзона`,
    { parse_mode: 'HTML' }
  )
);

// Диагностика: показывает, как именно бот разобрал фразу и каким путём.
// Нужна, чтобы не гадать по скриншотам, что именно крутится в проде.
bot.command('parse', async (ctx) => {
  const text = (ctx.match || '').trim();
  if (!text) return ctx.reply('Формат: /parse каждое 29 число в 19:00 снять показания');

  const viaLlm = Boolean(process.env.ANTHROPIC_API_KEY);
  const rec = parseRecurrence(text);
  const rest = rec ? rec.rest : text;

  const llm = await parseTask(rest);          // тот же путь, что при создании
  const regex = parseFallback(rest);          // всегда регулярки, для сравнения

  const show = (p) =>
    `${DateTime.fromJSDate(p.dueAt).setZone(TZ).toFormat('dd.MM HH:mm')}` +
    `${p.isAllDay ? ' (весь день)' : ''}\n` +
    `      напоминания: ${p.offsets.length ? p.offsets.join(', ') : '— (будут по умолчанию)'}\n` +
    `      название: «${esc(p.title)}»`;

  return ctx.reply(
    `<b>Разбор</b>\n` +
      `повтор: ${rec ? esc(describeRrule(rec.rrule)) + ` <code>${esc(rec.rrule)}</code>` : 'нет'}\n` +
      `остаток: «${esc(rest)}»\n\n` +
      `<b>Итог</b> (${viaLlm ? 'через Claude' : 'регулярки'})\n      ${show(llm)}\n\n` +
      (viaLlm ? `<b>Регулярки для сравнения</b>\n      ${show(regex)}\n\n` : '') +
      `<i>таймзона ${TZ}</i>`,
    { parse_mode: 'HTML' }
  );
});

bot.command('calfeed', async (ctx) => {
  const base = publicUrl();
  if (!base) {
    return ctx.reply(
      'У сервиса нет публичного адреса. В Railway: Settings → Networking → Generate Domain, ' +
        'после этого команда заработает.'
    );
  }
  const token = await feedToken();
  const url = `${base}/cal/${token}.ics`;
  return ctx.reply(
    `📆 <b>Подписка на календарь</b>\n\n<code>${url}</code>\n\n` +
      `<b>Google:</b> calendar.google.com → Другие календари → Подписаться по URL\n` +
      `<b>iPhone:</b> Настройки → Календарь → Учётные записи → Добавить → Другое → ` +
      `Подписной календарь\n\n` +
      `Задачи и повторы попадут в календарь автоматически. ` +
      `Google обновляет подписки раз в несколько часов, Apple — чаще.\n` +
      `<i>Ссылка не защищена паролем — не показывайте посторонним.</i>`,
    { parse_mode: 'HTML', link_preview_options: { is_disabled: true } }
  );
});

bot.command('tz', (ctx) => ctx.reply(`Таймзона: ${TZ}. Сейчас: ${DateTime.now().setZone(TZ).toFormat('dd.MM HH:mm')}`));

async function listTasks(ctx, { from, to, title }) {
  const { rows } = await q(
    `select t.*, u.name as assignee_name
       from tasks t left join users u on u.id = t.assignee_id
      where t.status = 'pending' and t.due_at >= $1 and t.due_at < $2
      order by t.due_at limit 50`,
    [from.toJSDate(), to.toJSDate()]
  );
  if (!rows.length) return ctx.reply(`${title}: пусто 🎉`);
  await ctx.reply(`<b>${title}</b>\n\n` + rows.map(taskLine).join('\n\n'), { parse_mode: 'HTML' });
}

const showToday = (ctx) => {
  const now = DateTime.now().setZone(TZ);
  return listTasks(ctx, { from: now.startOf('day'), to: now.endOf('day'), title: 'Сегодня' });
};

const showWeek = (ctx) => {
  const now = DateTime.now().setZone(TZ);
  return listTasks(ctx, { from: now.startOf('day'), to: now.plus({ days: 7 }), title: 'Ближайшая неделя' });
};

bot.command('today', showToday);
bot.command('week', showWeek);

bot.command('list', (ctx) => {
  const now = DateTime.now().setZone(TZ);
  return listTasks(ctx, { from: now.minus({ days: 7 }), to: now.plus({ days: 365 }), title: 'Все открытые' });
});

bot.command('done', async (ctx) => {
  const id = Number((ctx.match || '').trim().replace('#', ''));
  if (!id) return ctx.reply('Формат: /done 42');
  const user = await upsertUser(ctx.from, ctx.chat);
  const task = await completeTask(id, user.id);
  return ctx.reply(task ? `✅ Закрыл: ${esc(task.title)}` : 'Не нашёл такую открытую задачу', {
    parse_mode: 'HTML',
  });
});

bot.command('del', async (ctx) => {
  const id = Number((ctx.match || '').trim().replace('#', ''));
  if (!id) return ctx.reply('Формат: /del 42');
  const { rows } = await q(
    `update tasks set status='cancelled', updated_at=now()
      where id=$1 and status='pending' returning title`,
    [id]
  );
  if (!rows.length) return ctx.reply('Не нашёл такую открытую задачу');
  await q(
    `update reminders set status='cancelled' where task_id=$1 and status in ('pending','sending')`,
    [id]
  );
  return ctx.reply(`🗑 Удалил: ${esc(rows[0].title)}`, { parse_mode: 'HTML' });
});

bot.command('sync', async (ctx) => {
  await ctx.reply('Синхронизирую календари…');
  const t = await syncAllCalendars();
  return ctx.reply(`Готово: новых ${t.created}, обновлено ${t.updated}, снято ${t.cancelled}`);
});

bot.command('cal', async (ctx) => {
  const user = await upsertUser(ctx.from, ctx.chat);
  const args = (ctx.match || '').trim().split(/\s+/).filter(Boolean);
  const sub = (args.shift() || 'list').toLowerCase();

  if (sub === 'add') {
    const url = args.shift();
    if (!url || !/^https?:\/\//.test(url)) {
      return ctx.reply('Формат: /cal add https://…/basic.ics [название]');
    }
    const label = args.join(' ') || 'календарь';
    await q(
      `insert into calendars (owner_id, kind, url, label) values ($1,'ics',$2,$3)
       on conflict (url) do update set label = excluded.label, active = true`,
      [user.id, url, label]
    );
    await ctx.reply(`Подключил «${esc(label)}». Тяну события…`, { parse_mode: 'HTML' });
    const t = await syncAllCalendars();
    return ctx.reply(`Импортировано событий: ${t.created}`);
  }

  if (sub === 'del') {
    const id = Number(args.shift());
    await q('delete from calendars where id = $1', [id]);
    return ctx.reply(`Календарь #${id} отключён (его события тоже удалены)`);
  }

  const { rows } = await q(
    `select c.*, u.name as owner from calendars c left join users u on u.id = c.owner_id order by c.id`
  );
  if (!rows.length) return ctx.reply('Календари не подключены. /cal add <ics-ссылка>');
  return ctx.reply(
    rows
      .map(
        (c) =>
          `#${c.id} <b>${esc(c.label)}</b> — ${esc(c.owner || '?')}\n` +
          `   синк: ${c.last_sync_at ? DateTime.fromJSDate(c.last_sync_at).setZone(TZ).toFormat('dd.MM HH:mm') : 'ещё не было'}` +
          (c.last_error ? `\n   ⚠️ ${esc(c.last_error)}` : '')
      )
      .join('\n'),
    { parse_mode: 'HTML' }
  );
});

// --- создание задачи --------------------------------------------------------

/**
 * Карточка задачи. Одна на создание, правку и перенос: раньше они показывали
 * разное, и после редактирования пропадал список напоминаний.
 */
async function renderTaskCard(task, { icon = '📌', note = '' } = {}) {
  const { rows: who } = task.assignee_id
    ? await q('select name from users where id = $1', [task.assignee_id])
    : { rows: [] };

  const { rows: rems } = await q(
    `select label from reminders where task_id=$1 and status='pending' order by fire_at`,
    [task.id]
  );

  const planned = rems.map((r) => humanOffset(r.label)).filter((l) => l !== 'просрочено');

  const overdue =
    new Date(task.due_at) < new Date()
      ? '\n\n⚠️ Указанное время уже прошло — напоминаний не будет.'
      : '';

  return (
    `${icon} <b>${esc(task.title)}</b>${task.is_private ? ' 🔒' : ''}\n` +
    `🗓 ${fmt(new Date(task.due_at), TZ, task.is_all_day)}\n` +
    (who.length ? `👤 ${esc(who[0].name)}\n` : '') +
    `🔔 напомню: ${planned.length ? planned.join(', ') : 'нет (срок слишком близко)'}\n` +
    `<code>#${task.id}</code>` +
    overdue +
    note
  );
}

async function createTaskFromText(ctx, text) {
  // Сначала проверяем, не описано ли повторение — иначе «каждый вторник»
  // молча превратилось бы в разовую задачу на ближайший вторник
  const found = parseRecurrence(text);
  if (found) return createRecurrenceFromText(ctx, text, found);

  const creator = await upsertUser(ctx.from, ctx.chat);
  const parsed = await parseTask(text);
  const assignee = parsed.assigneeUsername ? await findUserByUsername(parsed.assigneeUsername) : null;

  const offsets = parsed.offsets.length ? parsed.offsets : DEFAULT_OFFSETS;

  const task = await withTx(async (c) => {
    const { rows } = await c.query(
      `insert into tasks
         (title, due_at, is_all_day, tz, assignee_id, creator_id, chat_id, thread_id, offsets,
          is_private, raw_input)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning *`,
      [
        parsed.title,
        parsed.dueAt,
        parsed.isAllDay,
        TZ,
        assignee?.id || null,
        creator.id,
        ctx.chat.id,
        ctx.message?.message_thread_id || null,
        JSON.stringify(offsets),
        ctx.chat.type === 'private',
        text,
      ]
    );
    await regenerateReminders(rows[0], c);
    return rows[0];
  });

  const warn = looksRecurring(text)
    ? '\n\n⚠️ Похоже на повторяющуюся задачу, но правило распознать не вышло — ' +
      'поставил разовую. Попробуйте формулировку вида «каждый вторник в 20:00 …».'
    : '';

  await ctx.reply(await renderTaskCard(task, { note: warn }), {
    parse_mode: 'HTML',
    reply_markup: taskKeyboard(task.id, task.recurrence_id, task.title),
  });
  return task;
}

async function createRecurrenceFromText(ctx, original, found) {
  const creator = await upsertUser(ctx.from, ctx.chat);
  // Время суток и название берём из остатка фразы, дату задаёт само правило
  const parsed = await parseTask(found.rest || original);
  const assignee = parsed.assigneeUsername ? await findUserByUsername(parsed.assigneeUsername) : null;
  const offsets = parsed.offsets.length ? parsed.offsets : DEFAULT_OFFSETS;

  const at = DateTime.fromJSDate(parsed.dueAt).setZone(TZ);
  const dtstart = DateTime.now()
    .setZone(TZ)
    .set({ hour: at.hour, minute: at.minute, second: 0, millisecond: 0 });

  const { rows } = await q(
    `insert into recurrences
       (title, rrule, dtstart, tz, is_all_day, assignee_id, creator_id, chat_id, thread_id, offsets,
        is_private)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning *`,
    [
      parsed.title,
      found.rrule,
      dtstart.toJSDate(),
      TZ,
      parsed.isAllDay,
      assignee?.id || null,
      creator.id,
      ctx.chat.id,
      ctx.message?.message_thread_id || null,
      JSON.stringify(offsets),
      ctx.chat.type === 'private',
    ]
  );
  const rec = rows[0];
  const created = await materializeRecurrence(rec);

  const upcoming = occurrencesBetween(rec, new Date(), DateTime.now().plus({ days: 60 }).toJSDate())
    .slice(0, 3)
    .map((d) => DateTime.fromJSDate(d).setZone(TZ).toFormat('dd.MM'))
    .join(', ');

  await ctx.reply(
    `🔁 <b>${esc(rec.title)}</b>\n` +
      `📅 ${esc(describeRrule(rec.rrule))}${rec.is_all_day ? '' : ` в ${at.toFormat('HH:mm')}`}\n` +
      (assignee ? `👤 ${esc(assignee.name)}\n` : '') +
      `🔔 напомню: ${offsets.map(humanOffset).join(', ')}\n` +
      (upcoming ? `▶️ ближайшие: ${upcoming}\n` : '') +
      `создано задач: ${created}\n<code>#R${rec.id}</code>`,
    { parse_mode: 'HTML', reply_markup: recurKeyboard(rec.id) }
  );
  return rec;
}

async function showRecurrences(ctx) {
  const { rows } = await q(
    `select r.*, u.name as assignee_name
       from recurrences r left join users u on u.id = r.assignee_id
      where r.active = true order by r.id`
  );
  if (!rows.length) {
    return ctx.reply(
      'Повторяющихся задач нет.\n\nПример: <code>каждый вторник в 20:00 вынести мусор</code>',
      { parse_mode: 'HTML' }
    );
  }
  return ctx.reply(
    '<b>Повторяющиеся задачи</b>\n\n' +
      rows
        .map((r) => {
          const next = occurrencesBetween(r, new Date(), DateTime.now().plus({ days: 90 }).toJSDate())[0];
          return (
            `🔁 <b>${esc(r.title)}</b>${r.assignee_name ? ` — ${esc(r.assignee_name)}` : ''}\n` +
            `   ${esc(describeRrule(r.rrule))}` +
            (r.is_all_day ? '' : ` в ${DateTime.fromJSDate(r.dtstart).setZone(TZ).toFormat('HH:mm')}`) +
            (next ? `, ближайшая ${DateTime.fromJSDate(next).setZone(TZ).toFormat('dd.MM')}` : '') +
            `  <code>#R${r.id}</code>`
          );
        })
        .join('\n\n') +
      '\n\nУдалить: <code>/recur del 3</code>',
    { parse_mode: 'HTML' }
  );
}

bot.command('recur', async (ctx) => {
  const args = (ctx.match || '').trim().split(/\s+/).filter(Boolean);
  if (args[0] === 'del') {
    const id = Number(String(args[1] || '').replace(/[#R]/gi, ''));
    if (!id) return ctx.reply('Формат: /recur del 3');
    const res = await deactivateRecurrence(id);
    return ctx.reply(
      res
        ? `Правило «${esc(res.recurrence.title)}» отключено, снято будущих задач: ${res.cancelled}`
        : 'Не нашёл такое правило',
      { parse_mode: 'HTML' }
    );
  }

  return showRecurrences(ctx);
});

// --- список покупок ---------------------------------------------------------

async function showShoppingList(ctx) {
  const { text, keyboard } = await renderList();
  return ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard });
}

bot.command('buy', async (ctx) => {
  const text = (ctx.match || '').trim();
  const user = await upsertUser(ctx.from, ctx.chat);
  if (!text) return showShoppingList(ctx);
  const added = await addItems(text, user.id);
  await ctx.reply(
    added.length ? `🛒 Добавлено: ${esc(added.join(', '))}` : 'Это уже есть в списке',
    { parse_mode: 'HTML' }
  );
  return showShoppingList(ctx);
});

bot.callbackQuery(/^buy_tog:(\d+)$/, async (ctx) => {
  // Сначала гасим «часики» на кнопке, потом работаем: если запрос упадёт,
  // пользователь хотя бы увидит реакцию, а не немую кнопку
  await ctx.answerCallbackQuery();
  try {
    const user = await upsertUser(ctx.from, ctx.chat);
    await toggleItem(Number(ctx.match[1]), user.id);
    await refreshMessage(ctx);
  } catch (e) {
    console.error('[buy_tog] не удалось переключить:', e.message);
    await ctx.reply('Не получилось отметить товар, попробуйте ещё раз');
  }
});

// Разделитель «Корзина» — кнопка только для вида
bot.callbackQuery('noop', (ctx) => ctx.answerCallbackQuery());

bot.callbackQuery('buy_edit_on', async (ctx) => {
  await ctx.answerCallbackQuery();
  await refreshMessage(ctx, true);
});

bot.callbackQuery('buy_edit_off', async (ctx) => {
  await ctx.answerCallbackQuery();
  await refreshMessage(ctx, false);
});

bot.callbackQuery(/^buy_del:(\d+)$/, async (ctx) => {
  const gone = await deleteItem(Number(ctx.match[1]));
  await ctx.answerCallbackQuery(gone ? `Удалил: ${gone.title}` : 'Уже нет');
  await refreshMessage(ctx, true); // остаёмся в правке — обычно удаляют несколько подряд
});

bot.callbackQuery('buy_clear', async (ctx) => {
  try {
    const n = await clearChecked();
    await ctx.answerCallbackQuery(`Убрано: ${n}`);
    await refreshMessage(ctx);
  } catch (e) {
    console.error('[buy_clear] ошибка:', e.message);
    await ctx.answerCallbackQuery('Не вышло');
  }
});

bot.callbackQuery('buy_add', async (ctx) => {
  const user = await upsertUser(ctx.from, ctx.chat);
  const isPrivate = ctx.chat.type === 'private';

  // В группе режим одноразовый: одно сообщение с товарами и выход.
  // Иначе кнопка на десять минут перехватывала бы общую переписку.
  await setState(user.id, 'shopping', null, { chatId: ctx.chat.id, oneShot: !isPrivate });
  await ctx.answerCallbackQuery();

  await ctx.reply(
    isPrivate
      ? 'Пишите товары — можно списком через запятую или с новой строки.\nКогда закончите, нажмите «Выйти».'
      : 'Пришлите товары одним сообщением — через запятую или с новой строки.',
    { reply_markup: isPrivate ? exitKeyboard : undefined }
  );
});

// --- редактирование ---------------------------------------------------------

async function applyEdit(ctx, id, text) {
  const parsed = await parseTask(text);

  // Что бот понял в первый раз — чтобы было с чем сравнивать
  const { rows: before } = await q('select raw_input, created_at from tasks where id = $1', [id]);
  const original = before[0];
  const assignee = parsed.assigneeUsername ? await findUserByUsername(parsed.assigneeUsername) : null;

  const task = await withTx(async (c) => {
    const { rows } = await c.query(
      `update tasks set title=$2, due_at=$3, is_all_day=$4, updated_at=now(),
                        assignee_id = coalesce($5::int, assignee_id),
                        offsets = case when $6::jsonb is null then offsets else $6::jsonb end
        where id=$1 and status='pending' returning *`,
      [
        id,
        parsed.title,
        parsed.dueAt,
        parsed.isAllDay,
        assignee?.id || null,
        parsed.offsets.length ? JSON.stringify(parsed.offsets) : null,
      ]
    );
    if (!rows.length) return null;
    await regenerateReminders(rows[0], c);
    return rows[0];
  });

  if (!task) return ctx.reply('Не нашёл такую открытую задачу');

  // Урок: исходная фраза должна была разобраться так, как получилось сейчас.
  // Учимся только на карандаше — перенос кнопкой или удаление слишком шумные.
  let learned = false;
  if (original?.raw_input && original.raw_input.trim() !== text.trim()) {
    try {
      const user = await upsertUser(ctx.from, ctx.chat);
      await saveExample({
        input: original.raw_input,
        nowAt: original.created_at,
        parsed,
        userId: user.id,
      });
      learned = true;
    } catch (e) {
      console.warn('[learn] не сохранил пример:', e.message);
    }
  }

  return ctx.reply(
    await renderTaskCard(task, {
      icon: '✏️',
      note: learned ? '\n<i>Запомнил, как вы это формулируете</i>' : '',
    }),
    { parse_mode: 'HTML', reply_markup: taskKeyboard(task.id, task.recurrence_id, task.title) }
  );
}

bot.command('edit', async (ctx) => {
  const raw = (ctx.match || '').trim();
  const m = /^#?(\d+)\s+(.+)$/s.exec(raw);
  if (!m) return ctx.reply('Формат: /edit 42 завтра в 19:00 новый текст');
  return applyEdit(ctx, Number(m[1]), m[2]);
});

bot.callbackQuery(/^edit:(\d+)$/, async (ctx) => {
  const user = await upsertUser(ctx.from, ctx.chat);
  await setState(user.id, 'edit', Number(ctx.match[1]), { chatId: ctx.chat.id, oneShot: true });
  await ctx.answerCallbackQuery();
  await ctx.reply(
    `Пришлите новый текст задачи <code>#${ctx.match[1]}</code> — с датой и временем, как при создании.`,
    { parse_mode: 'HTML' }
  );
});

bot.command('task', (ctx) => {
  const text = (ctx.match || '').trim();
  if (!text) return ctx.reply('Формат: /task завтра в 18:00 забрать посылку');
  return createTaskFromText(ctx, text);
});

bot.command('meter', async (ctx) => {
  const args = (ctx.match || '').trim().split(/\s+/).filter(Boolean);
  const sub = (args.shift() || '').toLowerCase();

  if (sub === 'add') {
    if (!args.length) {
      return ctx.reply(
        'Формат: <code>/meter add Вода холодная м3</code>\n' +
          'Многотарифный: <code>/meter add Электричество/День кВт</code>',
        { parse_mode: 'HTML' }
      );
    }
    // последнее слово — единица измерения, если она короткая и не часть названия
    let unit = '';
    if (args.length > 1 && args[args.length - 1].length <= 6) unit = args.pop();
    const meter = await addMeter(args.join(' '), unit);
    const shown = meter.group_name ? `${meter.group_name} · ${meter.name}` : meter.name;
    await ctx.reply(`📟 Добавил: <b>${esc(shown)}</b>${meter.unit ? ` (${esc(meter.unit)})` : ''}`, {
      parse_mode: 'HTML',
    });
    return showMeters(ctx);
  }

  if (sub === 'del') {
    const id = Number(String(args.shift() || '').replace(/[#M]/gi, ''));
    if (!id) return ctx.reply('Формат: <code>/meter del 2</code>', { parse_mode: 'HTML' });
    const gone = await removeMeter(id);
    return ctx.reply(
      gone
        ? `Убрал: ${esc(gone.name)}\nПоказания сохранены — вернуть: <code>/meter restore ${id}</code>`
        : 'Не нашёл такой счётчик',
      { parse_mode: 'HTML' }
    );
  }

  if (sub === 'restore') {
    const id = Number(String(args.shift() || '').replace(/[#M]/gi, ''));
    if (!id) return ctx.reply('Формат: <code>/meter restore 4</code>', { parse_mode: 'HTML' });
    const back = await restoreMeter(id);
    if (!back) return ctx.reply('Не нашёл такой счётчик');
    await ctx.reply(`Вернул: <b>${esc(displayName(back))}</b>`, { parse_mode: 'HTML' });
    return showMeters(ctx);
  }

  if (sub === 'force') {
    const id = Number(String(args.shift() || '').replace(/[#M]/gi, ''));
    const value = Number(String(args.shift() || '').replace(',', '.'));
    if (!id || !Number.isFinite(value)) {
      return ctx.reply('Формат: <code>/meter force 2 16.5</code>', { parse_mode: 'HTML' });
    }
    const user = await upsertUser(ctx.from, ctx.chat);
    const { at } = extractDate((ctx.match || '').trim());
    const result = await saveOneReading(id, value, user.id, at ? at.toJSDate() : null, true);
    if (!result) return ctx.reply('Счётчик не найден');
    await ctx.reply(renderOne(result), { parse_mode: 'HTML' });
    return showMeters(ctx);
  }

  if (sub === 'log') {
    const id = Number(String(args.shift() || '').replace(/[#M]/gi, ''));
    if (!id) return ctx.reply('Формат: <code>/meter log 4</code>', { parse_mode: 'HTML' });
    return ctx.reply(await renderLog(id), { parse_mode: 'HTML' });
  }

  if (sub === 'rm') {
    const id = Number(String(args.shift() || '').replace(/[#R]/gi, ''));
    if (!id) return ctx.reply('Формат: <code>/meter rm R12</code>', { parse_mode: 'HTML' });
    const gone = await removeReading(id);
    if (!gone) return ctx.reply('Не нашёл такое показание');
    const when = DateTime.fromJSDate(gone.taken_at).setZone(TZ).toFormat('dd.MM.yyyy');
    await ctx.reply(`↩️ Удалил показание ${gone.value} от ${when}`, { parse_mode: 'HTML' });
    return ctx.reply(await renderLog(gone.meter_id), { parse_mode: 'HTML' });
  }

  if (sub === 'undo') {
    const id = Number(String(args.shift() || '').replace(/[#M]/gi, ''));
    if (!id) return ctx.reply('Формат: <code>/meter undo 3</code>', { parse_mode: 'HTML' });
    const gone = await undoLastReading(id);
    if (!gone) return ctx.reply('У этого счётчика нет показаний');
    const when = DateTime.fromJSDate(gone.taken_at).setZone(TZ).toFormat('dd.MM');
    await ctx.reply(
      `↩️ Удалил показание <b>${esc(displayName(gone.meter))}</b>: ${gone.value} (от ${when})\n` +
        `Теперь можно внести заново с нужной датой.`,
      { parse_mode: 'HTML' }
    );
    return showMeters(ctx);
  }

  if (sub === 'all') {
    const all = await listAllMeters();
    if (!all.length) return ctx.reply('Счётчиков нет');
    return ctx.reply(
      '<b>Все счётчики</b>\n\n' +
        all
          .map(
            (m) =>
              `${m.active ? '📟' : '🚫'} ${esc(displayName(m))}` +
              `${m.unit ? ` (${esc(m.unit)})` : ''}  <code>#M${m.id}</code>` +
              `${m.active ? '' : ' — скрыт'}`
          )
          .join('\n') +
        '\n\nВернуть скрытый: <code>/meter restore ID</code>',
      { parse_mode: 'HTML' }
    );
  }

  // Числа прямо в команде: /meter 1234 567 [за 29.07]
  const { at, rest } = extractDate((ctx.match || '').trim());
  const numbers = extractNumbers(rest);
  if (numbers.length) {
    const user = await upsertUser(ctx.from, ctx.chat);
    const result = await saveReadings(numbers, user.id, at ? at.toJSDate() : null);
    return ctx.reply(renderReport(result), { parse_mode: 'HTML' });
  }

  return showMeters(ctx);
});

bot.command('bill', async (ctx) => {
  const args = (ctx.match || '').trim().split(/\s+/).filter(Boolean);
  const sub = (args.shift() || '').toLowerCase();

  if (sub === 'setup') {
    const { created, skipped } = await setupFromInvoices();
    let msg = created.length
      ? `Завёл начислений: ${created.length}`
      : 'Всё уже заведено — ничего не менял';
    if (skipped.length) msg += `\n\n⚠️ Пропущено:\n• ${skipped.map(esc).join('\n• ')}`;
    await ctx.reply(msg, { parse_mode: 'HTML' });
    return ctx.reply(await listCharges(), { parse_mode: 'HTML' });
  }

  if (sub === 'list' || sub === 'tariffs') {
    return ctx.reply(await listCharges(), { parse_mode: 'HTML' });
  }

  if (sub === 'save') {
    const bill = await computeBill();
    const saved = await saveBill(bill);
    return ctx.reply(
      saved ? 'Счёт сохранён — следующий буду сравнивать с ним.' : 'Нечего сохранять',
      { parse_mode: 'HTML' }
    );
  }

  const bill = await computeBill();
  return ctx.reply(await renderBill(bill), { parse_mode: 'HTML' });
});

bot.command('tariff', async (ctx) => {
  const args = (ctx.match || '').trim().split(/\s+/).filter(Boolean);

  if (!args.length) return ctx.reply(await listCharges(), { parse_mode: 'HTML' });

  if (args[0].toLowerCase() === 'del') {
    const id = Number(String(args[1] || '').replace(/[#C]/gi, ''));
    const gone = id ? await deactivateCharge(id) : null;
    return ctx.reply(gone ? `Убрал: ${esc(gone.name)}` : 'Формат: /tariff del #C3', {
      parse_mode: 'HTML',
    });
  }

  const id = Number(String(args[0]).replace(/[#C]/gi, ''));
  const rate = Number(String(args[1] || '').replace(',', '.'));
  const from = args[2];
  if (!id || !Number.isFinite(rate)) {
    return ctx.reply(
      'Формат: <code>/tariff #C3 31.5</code> — новая цена с сегодняшнего дня\n' +
        'Или с даты: <code>/tariff #C3 31.5 2026-09-01</code>',
      { parse_mode: 'HTML' }
    );
  }

  const created = await updateRate(id, rate, from);
  if (!created) return ctx.reply('Не нашёл такое начисление');
  return ctx.reply(
    `Новая цена для <b>${esc(created.name)}</b>: ${rate} с ${created.valid_from.toISOString().slice(0, 10)}\n` +
      `<i>Старая осталась в истории — прошлые периоды не пересчитаются.</i>`,
    { parse_mode: 'HTML' }
  );
});

bot.on('message:text', async (ctx, next) => {
  const text = ctx.message.text.trim();
  // Команды пропускаем дальше по цепочке: bot.command(), объявленные ниже
  // этого обработчика, иначе никогда не сработают — их съест этот return.
  if (text.startsWith('/')) return next();

  const isPrivate = ctx.chat.type === 'private';
  const replied = ctx.message.reply_to_message;

  // 1. Кнопки нижней клавиатуры (они есть только в личке)
  if (isPrivate) {
    if (text === '🛒 Покупки') return showShoppingList(ctx);
    if (text === '📋 Сегодня') return showToday(ctx);
    if (text === '📆 Неделя') return showWeek(ctx);
    if (text === '🔁 Повторы') return showRecurrences(ctx);
    if (text === '🏠 Дом') return showHome(ctx);
    if (text === '✅ Выйти') {
      const u = await upsertUser(ctx.from, ctx.chat);
      await clearState(u.id);
      return ctx.reply('Готово.', { reply_markup: mainKeyboard });
    }
  }

  // 2. Активный режим ввода проверяем ДО правила «в группе только с плюсом» —
  //    иначе в группе кнопка «Добавить» не работала бы вовсе.
  //    Поиск сразу по telegram-id, без записи в БД на каждое сообщение чата.
  const state = await getStateByTg(ctx.from.id, ctx.chat.id);

  if (state?.mode === 'shopping') {
    if (looksLikeTask(text)) {
      // Человек забыл, что включён режим списка — не хороним задачу в покупках
      await clearState(state.uid);
      await ctx.reply('Это больше похоже на задачу, чем на покупку — вышел из режима списка.', {
        reply_markup: isPrivate ? mainKeyboard : undefined,
      });
      // и падаем ниже, в обычное создание задачи
    } else {
      const added = await addItems(text, state.uid);
      if (state.one_shot) await clearState(state.uid);
      await ctx.reply(
        added.length ? `🛒 Добавлено: ${esc(added.join(', '))}` : 'Это уже в списке',
        { parse_mode: 'HTML' }
      );
      return showShoppingList(ctx);
    }
  }

  if (state?.mode === 'meter1') {
    const { at, rest } = extractDate(text);
    const numbers = extractNumbers(rest);
    if (!numbers.length) {
      await ctx.reply('Не нашёл числа. Пришлите показание цифрами.');
      return;
    }
    if (isImplausible(numbers[0])) {
      await ctx.reply(
        `⚠️ Показание ${numbers[0]} принять не могу — ноль на счётчике невозможен. ` +
          `Проверьте цифры и пришлите ещё раз.`
      );
      return;
    }
    await clearState(state.uid);
    const result = await saveOneReading(
      state.target_id,
      numbers[0],
      state.uid,
      at ? at.toJSDate() : null
    );
    if (!result) return ctx.reply('Счётчик не найден');

    if (result.rejected) {
      const when = DateTime.fromJSDate(result.prevAt).setZone(TZ).toFormat('dd.MM');
      return ctx.reply(
        `⚠️ Не принял: <b>${esc(numbers[0])}</b> меньше прежнего ` +
          `<b>${esc(result.prevValue)}</b> (от ${when}).\n\n` +
          `Счётчик назад не идёт. Проверьте, не внесли ли вы расход за месяц ` +
          `вместо показания на табло.\n\n` +
          `Если прибор действительно меняли: <code>/meter force ${state.target_id} ${numbers[0]}</code>`,
        { parse_mode: 'HTML' }
      );
    }
    await ctx.reply(renderOne(result), { parse_mode: 'HTML' });
    const warn = await checkGroup(result.meter.group_name);
    if (warn) await ctx.reply(warn, { parse_mode: 'HTML' });
    return showMeters(ctx);
  }

  if (state?.mode === 'meter') {
    const { at, rest } = extractDate(text);
    const numbers = extractNumbers(rest);
    if (numbers.length) {
      await clearState(state.uid);
      const result = await saveReadings(numbers, state.uid, at ? at.toJSDate() : null);
      await ctx.reply(renderReport(result), { parse_mode: 'HTML' });
      for (const g of [...new Set(result.report.map((r) => r.meter.group_name).filter(Boolean))]) {
        const warn = await checkGroup(g);
        if (warn) await ctx.reply(warn, { parse_mode: 'HTML' });
      }
      // Задачу «снять показания» закрываем сразу — она выполнена
      if (state.target_id) await completeTask(state.target_id, state.uid);
      return;
    }
    await ctx.reply('Не нашёл чисел. Пришлите показания цифрами или нажмите «Выйти».');
    return;
  }

  if (state?.mode === 'edit') {
    await clearState(state.uid);
    return applyEdit(ctx, state.target_id, text);
  }

  // 3. В группе не перехватываем всю болтовню — только явные «+задача».
  //    Исключение: прямое обращение к боту — там человек явно ждёт ответа,
  //    и молчание выглядит как поломка.
  if (!isPrivate && !text.startsWith('+')) {
    const addressed =
      ctx.message.reply_to_message?.from?.id === ctx.me.id ||
      new RegExp(`@${ctx.me.username}`, 'i').test(text);
    if (addressed) {
      await ctx.reply(
        'В группе задача ставится сообщением с <b>+</b> в начале:\n' +
          '<code>+завтра в 18:00 забрать посылку</code>\n\n' +
          'Ещё есть /today, /buy, /home — полный список по слешу.',
        { parse_mode: 'HTML' }
      );
    }
    return;
  }

  // 4. Ответ на чужое сообщение: текст оттуда становится задачей,
  //    а написанное сейчас — уточнением времени
  let payload = isPrivate ? text : text.slice(1).trim();
  if (replied && !replied.from?.is_bot) {
    const source = (replied.text || replied.caption || '').trim();
    if (source) payload = `${payload} ${source}`.trim();
  }

  if (!payload) return;
  return createTaskFromText(ctx, payload);
});

// --- инлайн-кнопки ----------------------------------------------------------

bot.callbackQuery(/^done:(\d+)$/, async (ctx) => {
  const id = Number(ctx.match[1]);
  const user = await upsertUser(ctx.from, ctx.chat);
  const task = await completeTask(id, user.id);
  await ctx.answerCallbackQuery(task ? 'Закрыто ✅' : 'Уже закрыта');
  if (task) {
    await ctx.editMessageText(`✅ <s>${esc(task.title)}</s>\nзакрыл(а) ${esc(user.name)}`, {
      parse_mode: 'HTML',
    });
  }
});

bot.callbackQuery(/^snooze:(\d+):(\d+)$/, async (ctx) => {
  const id = Number(ctx.match[1]);
  const minutes = Number(ctx.match[2]);
  const { rows } = await q('select due_at from tasks where id=$1', [id]);
  if (!rows.length) return ctx.answerCallbackQuery('Задача не найдена');
  const base = Math.max(Date.now(), new Date(rows[0].due_at).getTime());
  const task = await rescheduleTask(id, new Date(base + minutes * 60_000));
  await ctx.answerCallbackQuery(`Отложено на ${minutes} мин`);
  if (task) {
    await ctx.editMessageText(
      `⏰ <b>${esc(task.title)}</b>\nперенесено на ${fmt(new Date(task.due_at), TZ)}`,
      { parse_mode: 'HTML', reply_markup: taskKeyboard(task.id, task.recurrence_id, task.title) }
    );
  }
});

bot.callbackQuery(/^snoozemenu:(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.editMessageReplyMarkup({ reply_markup: snoozeKeyboard(Number(ctx.match[1])) });
});

bot.callbackQuery(/^snoozeback:(\d+)$/, async (ctx) => {
  const id = Number(ctx.match[1]);
  const { rows } = await q('select recurrence_id, title from tasks where id=$1', [id]);
  await ctx.answerCallbackQuery();
  await ctx.editMessageReplyMarkup({
    reply_markup: taskKeyboard(id, rows[0]?.recurrence_id, rows[0]?.title),
  });
});

/**
 * Именованные сдвиги. Считаем от «сейчас», а не от старого срока:
 * «вечером» должно означать сегодня вечером, даже если задача была на утро.
 */
bot.callbackQuery(/^snoozeto:(\d+):(evening|morning|weekend)$/, async (ctx) => {
  const id = Number(ctx.match[1]);
  const kind = ctx.match[2];
  const now = DateTime.now().setZone(TZ);
  let target;

  if (kind === 'evening') {
    target = now.set({ hour: 19, minute: 0, second: 0, millisecond: 0 });
    if (target <= now) target = target.plus({ days: 1 });
  } else if (kind === 'morning') {
    target = now.plus({ days: 1 }).set({ hour: 9, minute: 0, second: 0, millisecond: 0 });
  } else {
    // ближайшая суббота, 10 утра; если сегодня суббота — следующая
    target = now.set({ hour: 10, minute: 0, second: 0, millisecond: 0 });
    do {
      target = target.plus({ days: 1 });
    } while (target.weekday !== 6);
  }

  const task = await rescheduleTask(id, target.toJSDate());
  await ctx.answerCallbackQuery(task ? 'Перенёс' : 'Задача не найдена');
  if (task) {
    await ctx.editMessageText(await renderTaskCard(task, { icon: '⏰' }), {
      parse_mode: 'HTML',
      reply_markup: taskKeyboard(task.id, task.recurrence_id, task.title),
    });
  }
});

// --- счётчики ---------------------------------------------------------------

/**
 * Раздел «Дом» — всё про квартиру в одном месте.
 * Нижнее меню держим на пяти кнопках: дальше оно превращается в свалку.
 */
function homeKeyboard() {
  return new InlineKeyboard()
    .text('📟 Счётчики', 'home_meters')
    .text('🧾 Коммуналка', 'home_bill')
    .row()
    .text('💰 Тарифы', 'home_tariffs');
}

async function showHome(ctx) {
  return ctx.reply(
    '🏠 <b>Дом</b>\n\n' +
      'Счётчики — внести показания и посмотреть расход.\n' +
      'Коммуналка — расчёт за период по последним показаниям.\n' +
      'Тарифы — цены и абонплаты с историей изменений.',
    { parse_mode: 'HTML', reply_markup: homeKeyboard() }
  );
}

bot.callbackQuery('home_meters', async (ctx) => {
  await ctx.answerCallbackQuery();
  return showMeters(ctx);
});

bot.callbackQuery('home_bill', async (ctx) => {
  await ctx.answerCallbackQuery();
  const bill = await computeBill();
  return ctx.reply(await renderBill(bill), { parse_mode: 'HTML' });
});

bot.callbackQuery('home_tariffs', async (ctx) => {
  await ctx.answerCallbackQuery();
  return ctx.reply(await listCharges(), { parse_mode: 'HTML' });
});

bot.command('home', (ctx) => showHome(ctx));

bot.command('learned', async (ctx) => {
  const args = (ctx.match || '').trim().split(/\s+/).filter(Boolean);
  if (args[0]?.toLowerCase() === 'del') {
    const id = Number(String(args[1] || '').replace(/[#E]/gi, ''));
    const gone = id ? await deactivateExample(id) : null;
    return ctx.reply(
      gone ? `Забыл: «${esc(gone.input)}»` : 'Формат: /learned del E3',
      { parse_mode: 'HTML' }
    );
  }
  return ctx.reply(await renderExamples(), { parse_mode: 'HTML' });
});

async function showMeters(ctx) {
  return ctx.reply(await renderSummary(), {
    parse_mode: 'HTML',
    reply_markup: await metersKeyboard(),
  });
}

bot.callbackQuery(/^meter_one:(\d+)$/, async (ctx) => {
  const user = await upsertUser(ctx.from, ctx.chat);
  // target_id здесь — id счётчика, поэтому отдельный режим
  await setState(user.id, 'meter1', Number(ctx.match[1]), {
    chatId: ctx.chat.id,
    oneShot: true,
  });
  await ctx.answerCallbackQuery();
  const { rows } = await q('select name, unit from meters where id=$1', [Number(ctx.match[1])]);
  return ctx.reply(
    `Пришлите показание: <b>${esc(rows[0]?.name || '')}</b>${rows[0]?.unit ? ` (${esc(rows[0].unit)})` : ''}\n` +
      `<i>Снимали раньше? Допишите дату: «1250 за 29.07»</i>`,
    { parse_mode: 'HTML' }
  );
});

bot.callbackQuery('meter_all', async (ctx) => {
  const user = await upsertUser(ctx.from, ctx.chat);
  await setState(user.id, 'meter', null, { chatId: ctx.chat.id, oneShot: true });
  await ctx.answerCallbackQuery();
  return ctx.reply(await renderPrompt(), { parse_mode: 'HTML' });
});

bot.callbackQuery('meter_new', async (ctx) => {
  await ctx.answerCallbackQuery();
  return ctx.reply(
    'Добавить счётчик:\n<code>/meter add Вода холодная м3</code>\n\n' +
      'Последнее короткое слово — единица измерения.',
    { parse_mode: 'HTML' }
  );
});

bot.callbackQuery('meter_preset', async (ctx) => {
  const added = await addPreset();
  await ctx.answerCallbackQuery(added.length ? `Добавлено: ${added.length}` : 'Уже есть');
  return showMeters(ctx);
});

bot.callbackQuery(/^meter_input:(\d+)$/, async (ctx) => {
  const user = await upsertUser(ctx.from, ctx.chat);
  const meters = await listMeters();
  await ctx.answerCallbackQuery();
  if (!meters.length) {
    return ctx.reply('Сначала заведите счётчики: <code>/meter add Вода холодная м3</code>', {
      parse_mode: 'HTML',
    });
  }
  await setState(user.id, 'meter', Number(ctx.match[1]), { chatId: ctx.chat.id, oneShot: true });
  return ctx.reply(await renderPrompt(), { parse_mode: 'HTML' });
});

bot.callbackQuery(/^tomorrow:(\d+)$/, async (ctx) => {
  const id = Number(ctx.match[1]);
  const { rows } = await q('select * from tasks where id=$1', [id]);
  if (!rows.length) return ctx.answerCallbackQuery('Задача не найдена');
  const cur = DateTime.fromJSDate(rows[0].due_at).setZone(TZ);
  const next = cur.plus({ days: 1 }) < DateTime.now().setZone(TZ)
    ? DateTime.now().setZone(TZ).plus({ days: 1 }).set({ hour: cur.hour, minute: cur.minute })
    : cur.plus({ days: 1 });
  const task = await rescheduleTask(id, next.toJSDate());
  await ctx.answerCallbackQuery('Перенёс на завтра');
  await ctx.editMessageText(
    `📅 <b>${esc(task.title)}</b>\n${fmt(new Date(task.due_at), TZ, task.is_all_day)}`,
    { parse_mode: 'HTML', reply_markup: taskKeyboard(task.id, task.recurrence_id, task.title) }
  );
});

bot.callbackQuery(/^drop:(\d+)$/, async (ctx) => {
  const id = Number(ctx.match[1]);
  await q(`update tasks set status='cancelled', updated_at=now() where id=$1`, [id]);
  await q(`update reminders set status='cancelled' where task_id=$1 and status='pending'`, [id]);
  await ctx.answerCallbackQuery('Удалено');
  await ctx.editMessageText('🗑 Задача удалена');
});

bot.callbackQuery(/^drop_recur:(\d+)$/, async (ctx) => {
  const id = Number(ctx.match[1]);
  const res = await deactivateRecurrence(id);
  await ctx.answerCallbackQuery(res ? 'Повтор отключён' : 'Правило не найдено');
  if (res) {
    await ctx.editMessageText(
      `🚫 Повтор отключён: <b>${esc(res.recurrence.title)}</b>\n` +
        `снято будущих задач: ${res.cancelled}`,
      { parse_mode: 'HTML' }
    );
  }
});

bot.callbackQuery(/^notmine:(\d+)$/, async (ctx) => {
  const id = Number(ctx.match[1]);
  await q('update tasks set assignee_id = null, updated_at=now() where id=$1', [id]);
  await ctx.answerCallbackQuery('Снял исполнителя');
});

/**
 * Меню команд Telegram — то, что всплывает при вводе слеша и по кнопке «Меню».
 * Прописываем из кода, а не руками в BotFather: иначе список устаревает
 * при каждой новой команде и никто об этом не вспоминает.
 *
 * В группе показываем только осмысленное там: клавиатуры внизу нет,
 * зато нет и смысла предлагать личные настройки.
 */
const PRIVATE_COMMANDS = [
  { command: 'today', description: 'задачи на сегодня' },
  { command: 'week', description: 'план на неделю' },
  { command: 'buy', description: 'список покупок' },
  { command: 'home', description: 'счётчики, коммуналка, тарифы' },
  { command: 'bill', description: 'посчитать коммуналку' },
  { command: 'meter', description: 'счётчики и показания' },
  { command: 'recur', description: 'повторяющиеся задачи' },
  { command: 'list', description: 'все открытые задачи' },
  { command: 'cal', description: 'подключённые календари' },
  { command: 'calfeed', description: 'подписка на календарь' },
  { command: 'learned', description: 'чему бот научился' },
  { command: 'parse', description: 'проверить разбор фразы' },
  { command: 'help', description: 'что я умею' },
];

const GROUP_COMMANDS = [
  { command: 'today', description: 'задачи на сегодня' },
  { command: 'week', description: 'план на неделю' },
  { command: 'buy', description: 'список покупок' },
  { command: 'home', description: 'счётчики и коммуналка' },
  { command: 'recur', description: 'повторяющиеся задачи' },
  { command: 'help', description: 'что я умею' },
];

export async function registerCommands() {
  await bot.api.setMyCommands(PRIVATE_COMMANDS, { scope: { type: 'all_private_chats' } });
  await bot.api.setMyCommands(GROUP_COMMANDS, { scope: { type: 'all_group_chats' } });
  console.log('[bot] меню команд обновлено');
}

bot.catch((err) => console.error('[bot] необработанная ошибка:', err.message));

// --- утренний дайджест ------------------------------------------------------

export async function maybeSendDigest() {
  const now = DateTime.now().setZone(TZ);
  const hour = Number(process.env.DIGEST_HOUR || 8);
  if (now.hour !== hour) return;

  const today = now.toISODate();
  if ((await getSetting('last_digest_date')) === today) return;

  const chatId = process.env.FAMILY_CHAT_ID || (await getSetting('family_chat_id'));
  if (!chatId) return;

  const from = now.startOf('day').toJSDate();
  const to = now.endOf('day').toJSDate();

  // Общий дайджест — только семейные задачи. Личные, созданные в личке,
  // в общий чат не выкладываем.
  const { rows } = await q(
    `select t.*, u.name as assignee_name
       from tasks t left join users u on u.id = t.assignee_id
      where t.status='pending' and t.is_private = false
        and t.due_at >= $1 and t.due_at < $2
      order by t.due_at`,
    [from, to]
  );

  await setSetting('last_digest_date', today);

  const threadId = await getSetting('family_thread_id');
  if (rows.length) {
    await bot.api.sendMessage(
      chatId,
      `☀️ <b>План на сегодня</b>\n\n` + rows.map(taskLine).join('\n\n'),
      { parse_mode: 'HTML', message_thread_id: threadId || undefined }
    );
  }

  // Личный дайджест — каждому в личку, только его собственные задачи
  const { rows: personal } = await q(
    `select t.*, u.dm_chat_id, u.name as assignee_name
       from tasks t join users u on u.id = t.creator_id
      where t.status='pending' and t.is_private = true
        and u.dm_chat_id is not null
        and t.due_at >= $1 and t.due_at < $2
      order by u.dm_chat_id, t.due_at`,
    [from, to]
  );

  const byUser = new Map();
  for (const task of personal) {
    if (!byUser.has(task.dm_chat_id)) byUser.set(task.dm_chat_id, []);
    byUser.get(task.dm_chat_id).push(task);
  }

  for (const [dmChatId, tasks] of byUser) {
    try {
      await bot.api.sendMessage(
        dmChatId,
        `☀️ <b>Ваши задачи на сегодня</b>\n\n` + tasks.map(taskLine).join('\n\n'),
        { parse_mode: 'HTML' }
      );
      await new Promise((r) => setTimeout(r, 120));
    } catch (e) {
      console.warn('[digest] личный дайджест не ушёл:', e.message);
    }
  }
}
