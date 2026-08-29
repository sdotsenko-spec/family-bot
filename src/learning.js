import { q } from './db.js';
import { DateTime, TZ } from './time.js';

// Сколько примеров подмешивать в запрос. Пятнадцать почти ничего не стоят
// по токенам, а сотня раздует каждый запрос и потянет разбор к старым случаям.
const INJECT_LIMIT = Number(process.env.LEARN_EXAMPLES || 15);

const esc = (s) =>
  String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * Сохраняет пару «исходная фраза → правильный разбор».
 * Источник только один — правка через карандаш: там пользователь явно говорит,
 * что бот понял не так. Перенос кнопкой или удаление слишком шумные.
 */
export async function saveExample({ input, nowAt, parsed, userId }) {
  const text = String(input || '').trim();
  if (!text) return null;

  const result = {
    title: parsed.title,
    due_at: DateTime.fromJSDate(parsed.dueAt).setZone(TZ).toISO(),
    is_all_day: !!parsed.isAllDay,
    offsets: parsed.offsets || [],
    assignee: parsed.assigneeUsername || null,
  };

  const { rows } = await q(
    `insert into parse_examples (input, now_at, result, created_by)
     values ($1,$2,$3,$4::int)
     on conflict (lower(input)) do update set
       result = excluded.result, now_at = excluded.now_at, active = true
     returning *`,
    [text, nowAt || new Date(), JSON.stringify(result), userId || null]
  );
  return rows[0];
}

export async function recentExamples(limit = INJECT_LIMIT) {
  const { rows } = await q(
    `select * from parse_examples where active = true
      order by created_at desc limit $1`,
    [limit]
  );
  return rows.reverse(); // от старых к свежим — свежие ближе к запросу
}

/** Блок для системного промпта. Пусто, если учиться пока не на чем. */
export async function examplesBlock() {
  const rows = await recentExamples();
  if (!rows.length) return '';

  const lines = rows.map((r) => {
    const now = DateTime.fromJSDate(r.now_at).setZone(TZ).toISO();
    return `Сейчас: ${now}\nВвод: ${JSON.stringify(r.input)}\nВерно: ${JSON.stringify(r.result)}`;
  });

  return (
    '\n\nТак формулирует эта семья — разбирай похожие фразы так же ' +
    '(примеры собраны из исправлений пользователя):\n\n' +
    lines.join('\n\n')
  );
}

export async function renderExamples() {
  const { rows } = await q(
    `select * from parse_examples where active = true order by created_at desc limit 30`
  );
  if (!rows.length) {
    return 'Пока ничему не научился.\n\nИсправьте задачу карандашом — и разбор похожих фраз станет точнее.';
  }
  return (
    `<b>Выучено примеров: ${rows.length}</b>\n\n` +
    rows
      .map(
        (r) =>
          `«${esc(r.input)}»\n   → ${esc(r.result.title)}` +
          `${r.result.offsets?.length ? ` · ${esc(r.result.offsets.join(', '))}` : ''}` +
          `  <code>#E${r.id}</code>`
      )
      .join('\n\n') +
    '\n\n<i>Удалить неудачный: /learned del E3</i>'
  );
}

export async function deactivateExample(id) {
  const { rows } = await q(
    `update parse_examples set active = false where id = $1 returning input`,
    [id]
  );
  return rows[0] || null;
}
