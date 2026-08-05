import { q } from './db.js';
import { DateTime, TZ } from './time.js';

const esc = (s) =>
  String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Признак того, что задача про счётчики — по ней предложим внести показания. */
export function isMeterTask(title) {
  return /сч[ёе]тчик|показани|водом|электросч/iu.test(String(title || ''));
}

export async function listMeters() {
  const { rows } = await q(
    `select * from meters where active = true order by position, id`
  );
  return rows;
}

export async function addMeter(name, unit = '') {
  const { rows } = await q(
    `insert into meters (name, unit, position)
     values ($1, $2, coalesce((select max(position) + 1 from meters), 0))
     returning *`,
    [name.trim(), unit.trim()]
  );
  return rows[0];
}

export async function removeMeter(id) {
  const { rows } = await q(
    `update meters set active = false where id = $1 returning name`,
    [id]
  );
  return rows[0] || null;
}

/**
 * Числа из свободного текста: «вода 1234,5 свет 567» → [1234.5, 567].
 * Запятая как десятичный разделитель — так пишут в быту.
 */
export function extractNumbers(text) {
  const out = [];
  const re = /(\d+(?:[.,]\d+)?)/g;
  let m;
  while ((m = re.exec(text))) out.push(Number(m[1].replace(',', '.')));
  return out;
}

/** Последние два показания счётчика — для расчёта расхода. */
async function lastTwo(meterId) {
  const { rows } = await q(
    `select value, taken_at from meter_readings
      where meter_id = $1 order by taken_at desc limit 2`,
    [meterId]
  );
  return rows;
}

/**
 * Сохраняет показания по порядку счётчиков и возвращает отчёт с расходом.
 * Меньшее прошлого значение не отвергаем — счётчик могли заменить,
 * но помечаем, чтобы человек заметил.
 */
export async function saveReadings(values, userId) {
  const meters = await listMeters();
  const report = [];

  for (let i = 0; i < Math.min(values.length, meters.length); i++) {
    const meter = meters[i];
    const value = values[i];
    const prev = (await lastTwo(meter.id))[0];

    await q(
      `insert into meter_readings (meter_id, value, added_by) values ($1,$2,$3::int)`,
      [meter.id, value, userId || null]
    );

    let delta = null;
    let days = null;
    if (prev) {
      delta = Number(value) - Number(prev.value);
      days = Math.max(
        1,
        Math.round(DateTime.now().diff(DateTime.fromJSDate(prev.taken_at), 'days').days)
      );
    }
    report.push({ meter, value, delta, days });
  }

  return { report, extra: values.length - meters.length };
}

const fmtNum = (n) =>
  Number(n)
    .toFixed(3)
    .replace(/\.?0+$/, '')
    .replace('.', ',');

export function renderReport({ report, extra }) {
  if (!report.length) return 'Не нашёл чисел в сообщении.';

  const lines = report.map(({ meter, value, delta, days }) => {
    const unit = meter.unit ? ` ${esc(meter.unit)}` : '';
    let tail = '';
    if (delta === null) tail = ' <i>(первое показание)</i>';
    else if (delta < 0) tail = ` ⚠️ <i>меньше прошлого на ${fmtNum(-delta)}${unit}</i>`;
    else tail = ` — расход ${fmtNum(delta)}${unit} за ${days} дн.`;
    return `📟 <b>${esc(meter.name)}</b>: ${fmtNum(value)}${unit}${tail}`;
  });

  if (extra > 0) lines.push(`<i>Лишних чисел: ${extra} — счётчиков меньше</i>`);
  if (extra < 0) lines.push(`<i>Не хватило чисел для ${-extra} счётчиков</i>`);

  return lines.join('\n');
}

/** Сводка: последнее показание и расход по каждому счётчику. */
export async function renderSummary() {
  const meters = await listMeters();
  if (!meters.length) {
    return (
      'Счётчики не заведены.\n\n' +
      'Добавить: <code>/meter add Вода холодная м3</code>\n' +
      'Последнее слово — единица измерения (можно не указывать).'
    );
  }

  const lines = [];
  for (const meter of meters) {
    const rows = await lastTwo(meter.id);
    const unit = meter.unit ? ` ${esc(meter.unit)}` : '';
    if (!rows.length) {
      lines.push(`📟 <b>${esc(meter.name)}</b> — показаний ещё нет  <code>#M${meter.id}</code>`);
      continue;
    }
    const [last, prev] = rows;
    const when = DateTime.fromJSDate(last.taken_at).setZone(TZ).toFormat('dd.MM');
    let tail = '';
    if (prev) {
      const delta = Number(last.value) - Number(prev.value);
      const days = Math.max(
        1,
        Math.round(
          DateTime.fromJSDate(last.taken_at).diff(DateTime.fromJSDate(prev.taken_at), 'days').days
        )
      );
      tail = `\n   расход ${fmtNum(delta)}${unit} за ${days} дн.`;
    }
    lines.push(
      `📟 <b>${esc(meter.name)}</b>: ${fmtNum(last.value)}${unit} <i>(${when})</i>` +
        tail +
        `  <code>#M${meter.id}</code>`
    );
  }

  return (
    '<b>Счётчики</b>\n\n' +
    lines.join('\n\n') +
    '\n\nВнести показания: просто пришлите числа в этом порядке.'
  );
}

/** Подсказка при вводе: в каком порядке присылать числа. */
export async function renderPrompt() {
  const meters = await listMeters();
  if (!meters.length) {
    return 'Сначала заведите счётчики: <code>/meter add Вода холодная м3</code>';
  }
  return (
    'Пришлите показания числами в этом порядке:\n' +
    meters.map((m, i) => `${i + 1}. ${esc(m.name)}${m.unit ? ` (${esc(m.unit)})` : ''}`).join('\n') +
    '\n\nМожно одной строкой через пробел или запятую.'
  );
}
