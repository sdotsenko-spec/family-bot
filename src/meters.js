import { InlineKeyboard } from 'grammy';
import { q } from './db.js';
import { DateTime, TZ } from './time.js';

const esc = (s) =>
  String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Признак того, что задача про счётчики — по ней предложим внести показания. */
export function isMeterTask(title) {
  return /сч[ёе]тчик|показани|водом|электросч/iu.test(String(title || ''));
}

/** Полное имя для показа: «Электричество · День». */
export function displayName(meter) {
  return meter.group_name ? `${meter.group_name} · ${meter.name}` : meter.name;
}

export async function listMeters() {
  const { rows } = await q(
    `select * from meters where active = true
      order by coalesce(group_name, name), position, id`
  );
  return rows;
}

const ROLE_BY_NAME = { день: 'day', ночь: 'night', общий: 'total', общее: 'total' };

/**
 * «Электричество/День кВт» → группа «Электричество», регистр «День».
 * Роль (день/ночь/общий) выводим из названия — по ней потом сверяем суммы.
 */
export async function addMeter(rawName, unit = '') {
  const parts = String(rawName).split('/').map((p) => p.trim()).filter(Boolean);
  const group = parts.length > 1 ? parts[0] : null;
  const name = parts.length > 1 ? parts.slice(1).join(' / ') : parts[0] || rawName.trim();
  const role = ROLE_BY_NAME[name.toLowerCase()] || null;

  const { rows } = await q(
    `insert into meters (name, unit, group_name, role, position)
     values ($1,$2,$3,$4, coalesce((select max(position) + 1 from meters), 0))
     returning *`,
    [name, unit.trim(), group, role]
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
/**
 * Дата снятия показания, если её указали: «1250 за 29.07», «1250 29 июля».
 * Возвращает { at, rest } — дату и текст без неё.
 *
 * Дату обязательно вырезаем ДО поиска чисел, иначе «29.07» само попадёт
 * в показания как число 29.07.
 */
const MONTHS_RU = {
  январ: 1, феврал: 2, март: 3, апрел: 4, ма: 5, июн: 6,
  июл: 7, август: 8, сентябр: 9, октябр: 10, ноябр: 11, декабр: 12,
};

export function extractDate(text, tz = TZ, now = DateTime.now().setZone(tz)) {
  let rest = text;
  let at = null;

  let m = /(?:за\s+)?(\d{1,2})[./](\d{1,2})(?:[./](\d{2,4}))?(?![\d,.])/u.exec(text);
  if (m) {
    const year = m[3] ? (m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3])) : now.year;
    at = DateTime.fromObject({ year, month: Number(m[2]), day: Number(m[1]) }, { zone: tz });
    // Без года: дата в будущем — значит имелся в виду прошлый год
    if (!m[3] && at > now) at = at.minus({ years: 1 });
  } else {
    m = new RegExp(
      `(?:за\\s+)?(\\d{1,2})\\s+(${Object.keys(MONTHS_RU).sort((a, b) => b.length - a.length).join('|')})[а-яё]*`,
      'iu'
    ).exec(text);
    if (m) {
      const month = MONTHS_RU[Object.keys(MONTHS_RU).find((k) => m[2].toLowerCase().startsWith(k))];
      at = DateTime.fromObject({ year: now.year, month, day: Number(m[1]) }, { zone: tz });
      if (at > now) at = at.minus({ years: 1 });
    }
  }

  if (!at || !at.isValid) return { at: null, rest };

  // Полдень: время суток для показаний не важно, но полночь путает расчёт дней
  at = at.set({ hour: 12 });
  rest = (text.slice(0, m.index) + ' ' + text.slice(m.index + m[0].length)).replace(/\s+/g, ' ');
  return { at, rest };
}

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
export async function saveReadings(values, userId, takenAt = null) {
  const meters = await listMeters();
  const report = [];

  for (let i = 0; i < Math.min(values.length, meters.length); i++) {
    const meter = meters[i];
    const value = values[i];
    const prev = (await lastTwo(meter.id))[0];

    await q(
      `insert into meter_readings (meter_id, value, added_by, taken_at)
       values ($1,$2,$3::int, coalesce($4::timestamptz, now()))`,
      [meter.id, value, userId || null, takenAt]
    );

    let delta = null;
    let days = null;
    if (prev) {
      delta = Number(value) - Number(prev.value);
      const from = takenAt ? DateTime.fromJSDate(takenAt) : DateTime.now();
      days = Math.max(1, Math.round(from.diff(DateTime.fromJSDate(prev.taken_at), 'days').days));
    }
    report.push({ meter, value, delta, days, takenAt });
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

  const lines = report.map(({ meter, value, delta, days, takenAt }) => {
    const unit = meter.unit ? ` ${esc(meter.unit)}` : '';
    let tail = '';
    if (delta === null) tail = ' <i>(первое показание)</i>';
    else if (delta < 0) tail = ` ⚠️ <i>меньше прошлого на ${fmtNum(-delta)}${unit}</i>`;
    else tail = ` — расход ${fmtNum(delta)}${unit} за ${days} дн.`;
    const dated = takenAt
      ? ` <i>(на ${DateTime.fromJSDate(takenAt).setZone(TZ).toFormat('dd.MM')})</i>`
      : '';
    return `📟 <b>${esc(displayName(meter))}</b>: ${fmtNum(value)}${unit}${dated}${tail}`;
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
      lines.push(
        `📟 <b>${esc(displayName(meter))}</b> — показаний ещё нет  <code>#M${meter.id}</code>`
      );
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
      `📟 <b>${esc(displayName(meter))}</b>: ${fmtNum(last.value)}${unit} <i>(${when})</i>` +
        tail +
        `  <code>#M${meter.id}</code>`
    );
  }

  // Итог по многотарифным приборам — суммарный расход за период
  const groups = [...new Set(meters.map((m) => m.group_name).filter(Boolean))];
  const extras = [];
  for (const g of groups) {
    const zones = meters.filter((m) => m.group_name === g && m.role !== 'total');
    let sum = 0;
    let any = false;
    let unit = '';
    for (const z of zones) {
      const rows = await lastTwo(z.id);
      if (rows.length < 2) continue;
      sum += Number(rows[0].value) - Number(rows[1].value);
      unit = z.unit;
      any = true;
    }
    if (any) extras.push(`⚡️ <b>${esc(g)}</b> всего: ${fmtNum(sum)}${unit ? ` ${esc(unit)}` : ''}`);
  }

  return (
    '<b>Счётчики</b>\n\n' + lines.join('\n\n') + (extras.length ? '\n\n' + extras.join('\n') : '')
  );
}

/**
 * Сверка двухтарифного прибора: расход по дню и ночи должен сходиться
 * с расходом по общему регистру. Расхождение почти всегда означает
 * опечатку в цифрах — лучше поймать сразу, чем спорить с поставщиком.
 */
export async function checkGroup(groupName) {
  if (!groupName) return null;
  const { rows: meters } = await q(
    `select * from meters where active = true and group_name = $1`,
    [groupName]
  );
  const byRole = Object.fromEntries(meters.filter((m) => m.role).map((m) => [m.role, m]));
  if (!byRole.day || !byRole.night || !byRole.total) return null;

  const deltas = {};
  for (const role of ['day', 'night', 'total']) {
    const rows = await lastTwo(byRole[role].id);
    if (rows.length < 2) return null; // сравнивать пока не с чем
    deltas[role] = Number(rows[0].value) - Number(rows[1].value);
  }

  const sum = deltas.day + deltas.night;
  const diff = sum - deltas.total;
  if (Math.abs(diff) < 0.5) return null; // округления — не повод шуметь

  return (
    `⚠️ <b>${esc(groupName)}</b>: день + ночь = ${fmtNum(sum)}, ` +
    `а общий показал ${fmtNum(deltas.total)} (разница ${fmtNum(Math.abs(diff))}). ` +
    `Проверьте цифры.`
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
    meters
      .map((m, i) => `${i + 1}. ${esc(displayName(m))}${m.unit ? ` (${esc(m.unit)})` : ''}`)
      .join('\n') +
    '\n\nМожно одной строкой через пробел или запятую.\n' +
    '<i>Если показания снимали раньше — допишите дату: «1250 876 5670 за 29.07»</i>'
  );
}

/** Сохраняет показание одного счётчика (кнопочный путь). */
export async function saveOneReading(meterId, value, userId, takenAt = null) {
  const { rows } = await q('select * from meters where id = $1', [meterId]);
  const meter = rows[0];
  if (!meter) return null;

  const prev = (await lastTwo(meter.id))[0];
  await q(
    `insert into meter_readings (meter_id, value, added_by, taken_at)
     values ($1,$2,$3::int, coalesce($4::timestamptz, now()))`,
    [meter.id, value, userId || null, takenAt]
  );

  let delta = null;
  let days = null;
  if (prev) {
    delta = Number(value) - Number(prev.value);
    const from = takenAt ? DateTime.fromJSDate(takenAt) : DateTime.now();
    days = Math.max(1, Math.round(from.diff(DateTime.fromJSDate(prev.taken_at), 'days').days));
  }
  return { meter, value, delta, days, takenAt };
}

/**
 * Клавиатура счётчиков: кнопка на каждый + ввод всех сразу.
 * Рядом с названием — последнее показание, чтобы видеть, что вводишь поверх.
 */
export function renderOne({ meter, value, delta, days, takenAt }) {
  const unit = meter.unit ? ` ${esc(meter.unit)}` : '';
  let tail = '';
  if (delta === null) tail = '\n<i>первое показание</i>';
  else if (delta < 0) tail = `\n⚠️ <i>меньше прошлого на ${fmtNum(-delta)}${unit}</i>`;
  else tail = `\nрасход <b>${fmtNum(delta)}${unit}</b> за ${days} дн.`;
  const dated = takenAt
    ? ` <i>(на ${DateTime.fromJSDate(takenAt).setZone(TZ).toFormat('dd.MM')})</i>`
    : '';
  return `📟 <b>${esc(displayName(meter))}</b>: ${fmtNum(value)}${unit}${dated}${tail}`;
}

export async function metersKeyboard() {
  const meters = await listMeters();
  const kb = new InlineKeyboard();
  let currentGroup = null;

  for (const meter of meters) {
    // Заголовок прибора — разделитель перед его регистрами
    if (meter.group_name && meter.group_name !== currentGroup) {
      kb.text(`— ⚡️ ${meter.group_name} —`, 'noop').row();
      currentGroup = meter.group_name;
    } else if (!meter.group_name) {
      currentGroup = null;
    }

    const rows = await lastTwo(meter.id);
    const last = rows[0] ? ` · ${fmtNum(rows[0].value)}` : '';
    const label = meter.group_name ? meter.name : `📟 ${meter.name}`;
    kb.text(`${label}${last}`, `meter_one:${meter.id}`).row();
  }

  if (meters.length > 1) kb.text('📥 Ввести все сразу', 'meter_all').row();
  kb.text('➕ Добавить счётчик', 'meter_new');
  if (!meters.length) kb.row().text('⚡️ Типовой набор', 'meter_preset');
  return kb;
}

// Типовой набор для квартиры — чтобы не заводить руками по одному
export const PRESET = [
  ['Вода холодная', 'м³'],
  ['Вода горячая', 'м³'],
  ['Электричество/День', 'кВт'],
  ['Электричество/Ночь', 'кВт'],
  ['Электричество/Общий', 'кВт'],
  ['Отопление', 'Гкал'],
];

export async function addPreset() {
  const existing = (await listMeters()).map((m) => displayName(m).toLowerCase());
  const added = [];
  for (const [name, unit] of PRESET) {
    if (existing.includes(name.replace('/', ' · ').toLowerCase())) continue;
    await addMeter(name, unit);
    added.push(name);
  }
  return added;
}

export { fmtNum };
