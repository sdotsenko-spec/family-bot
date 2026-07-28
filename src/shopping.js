import { InlineKeyboard } from 'grammy';
import { q } from './db.js';

const MAX_SHOWN = 40;

const esc = (s) =>
  String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * «молоко, хлеб 2 шт\nсыр» → ['молоко', 'хлеб 2 шт', 'сыр']
 * Разделяем по переводам строк и запятым — так люди и диктуют.
 */
export function splitItems(text) {
  return text
    .split(/[\n,;]+/)
    .map((s) => s.replace(/^[\s\-–—•*]+/, '').trim())
    .filter((s) => s.length > 0 && s.length <= 120);
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
  const { rows } = await q(
    `update shopping_items
        set checked = not checked,
            checked_by = case when checked then null else $2 end,
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
  for (const item of items.slice(0, MAX_SHOWN)) {
    kb.text(`${item.checked ? '✅' : '☐'} ${item.title}`, `buy_tog:${item.id}`).row();
  }
  kb.text('➕ Добавить', 'buy_add');
  if (done.length) kb.text('🧹 Убрать купленное', 'buy_clear');

  const text = items.length
    ? `🛒 <b>Список покупок</b>\nНужно купить: ${open.length}` +
      (done.length ? `, в корзине: ${done.length}` : '') +
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
