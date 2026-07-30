import { InlineKeyboard } from 'grammy';
import { q } from './db.js';

const MAX_SHOWN = 40;

const esc = (s) =>
  String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * «молоко, хлеб 2 шт\nсыр» → ['молоко', 'хлеб 2 шт', 'сыр']
 * Разделяем по переводам строк и запятым — так люди и диктуют.
 */
// Запятая внутри числа — десятичный разделитель, а не граница товара:
// «Мясо на фарш 1,5 кг» это один пункт, а не «Мясо на фарш 1» и «5 кг».
// Прячем такие запятые на время разбора.
const DECIMAL_MARK = '\u0000';

export function splitItems(text) {
  return text
    .replace(/(\d)\s*,\s*(\d)/g, `$1${DECIMAL_MARK}$2`)
    .split(/[\n,;]+/)
    .map((s) => s.replace(/^[\s\-–—•*]+/, '').replace(new RegExp(DECIMAL_MARK, 'g'), ',').trim())
    .filter((s) => s.length > 0 && s.length <= 120);
}

/**
 * Похоже ли сообщение на задачу, а не на товар.
 * Нужно как страховка: если человек забыл, что включён режим списка,
 * «завтра в 14:00 собеседование» не должно молча стать покупкой.
 * Продукты не содержат времени, дат и слова «напомни».
 */
export function looksLikeTask(text) {
  const t = text.toLowerCase();
  // Только явные признаки времени. Длину списка как признак использовать
  // нельзя: настоящий список продуктов почти всегда длинный.
  if (/\d{1,2}:\d{2}/.test(t)) return true;
  if (/(?<![а-яё])(завтра|послезавтра|сегодня|напом[а-яё]*|через\s+\d)/u.test(t)) return true;
  if (/(?<![а-яё])кажд[а-яё]*(?![а-яё])/u.test(t)) return true;
  return false;
}

export async function addItems(text, userId) {
  const items = splitItems(text);
  const added = [];
  for (const title of items) {
    // Уже есть некупленный такой же — не плодим дубли
    const { rows: dup } = await q(
      `select id from shopping_items where checked = false and lower(title) = lower($1) limit 1`,
      [title]
    );
    if (dup.length) continue;
    const { rows } = await q(
      `insert into shopping_items (title, added_by) values ($1,$2) returning title`,
      [title, userId || null]
    );
    added.push(rows[0].title);
  }
  return added;
}

export async function toggleItem(id, userId) {
  // $2::int обязателен: внутри CASE Postgres не выводит тип параметра
  // из целевой колонки и падает с «could not determine data type»
  const { rows } = await q(
    `update shopping_items
        set checked = not checked,
            checked_by = case when checked then null else $2::int end,
            checked_at = case when checked then null else now() end
      where id = $1
      returning *`,
    [id, userId || null]
  );
  return rows[0] || null;
}

export async function clearChecked() {
  const { rowCount } = await q('delete from shopping_items where checked = true');
  return rowCount;
}

export async function listItems() {
  const { rows } = await q(
    `select * from shopping_items order by checked, created_at limit ${MAX_SHOWN + 1}`
  );
  return rows;
}

/** Сообщение со списком: текст + инлайн-кнопки-галочки. */
export async function renderList() {
  const items = await listItems();
  const open = items.filter((i) => !i.checked);
  const done = items.filter((i) => i.checked);

  const kb = new InlineKeyboard();

  for (const item of open.slice(0, MAX_SHOWN)) {
    kb.text(`☐ ${item.title}`, `buy_tog:${item.id}`).row();
  }

  // Купленное уезжает в «корзину» под разделитель, но остаётся кнопкой —
  // чтобы можно было снять галочку, если промахнулся
  if (done.length) {
    kb.text(`— 🧺 Корзина (${done.length}) —`, 'noop').row();
    for (const item of done.slice(0, MAX_SHOWN)) {
      kb.text(`✅ ${item.title}`, `buy_tog:${item.id}`).row();
    }
  }

  kb.text('➕ Добавить', 'buy_add');
  if (done.length) kb.text('🧹 Очистить корзину', 'buy_clear');

  const text = items.length
    ? `🛒 <b>Список покупок</b>\nНужно купить: ${open.length}` +
      (done.length ? ` · в корзине: ${done.length}` : '') +
      (items.length > MAX_SHOWN ? `\n<i>показаны первые ${MAX_SHOWN}</i>` : '')
    : `🛒 <b>Список покупок</b>\nПусто. Нажмите «Добавить» или напишите <code>/buy молоко, хлеб</code>`;

  return { text, keyboard: kb };
}

/** Обновляет сообщение со списком на месте; если не вышло — не страшно. */
export async function refreshMessage(ctx) {
  const { text, keyboard } = await renderList();
  try {
    await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard });
  } catch (e) {
    // Telegram ругается, если текст и клавиатура не изменились — это нормально
    if (!/message is not modified/i.test(e.message)) throw e;
  }
}

export { esc };
