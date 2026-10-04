// rrule — CommonJS, именованные экспорты в ESM не пробрасываются
import rrulePkg from 'rrule';
const { RRule, rrulestr } = rrulePkg;
import { q, withTx } from './db.js';
import { regenerateReminders, cancelReminders } from './reminders.js';
import { DateTime, TZ } from './time.js';

const HORIZON_DAYS = Number(process.env.RECUR_HORIZON_DAYS || 30);

// Как и в parser.js: \b в JS не работает вокруг кириллицы
const B = '(?<![0-9A-Za-zА-Яа-яЁё_])';
const E = '(?![0-9A-Za-zА-Яа-яЁё_])';

const WD = [
  ['понедельник', 'MO'],
  ['вторник', 'TU'],
  ['сред', 'WE'],
  ['четверг', 'TH'],
  ['пятниц', 'FR'],
  ['суббот', 'SA'],
  ['воскресень', 'SU'],
];
const WD_ALT = WD.map(([stem]) => stem).join('|');
const WD_CODE = (word) => {
  const w = word.toLowerCase();
  const hit = WD.find(([stem]) => w.startsWith(stem));
  return hit ? hit[1] : null;
};

const ORDINALS = [
  [/^перв/i, 1],
  [/^втор/i, 2],
  [/^трет/i, 3],
  [/^четв[её]рт/i, 4],
  [/^последн/i, -1],
  [/^предпоследн/i, -2],
];

/**
 * Ищет во фразе описание повторения.
 * Возвращает { rrule, rest } — правило и текст без распознанной части,
 * либо null, если повторения нет.
 */
export function parseRecurrence(input) {
  let text = ' ' + input.trim() + ' ';
  let rrule = null;

  const eat = (source) => {
    const m = new RegExp(source, 'iu').exec(text);
    if (!m) return null;
    text = (text.slice(0, m.index) + ' ' + text.slice(m.index + m[0].length)).replace(/\s+/g, ' ');
    return m;
  };

  let m;

  // «каждый предпоследний / последний день месяца»
  if ((m = eat(`${B}кажд[а-яё]*\\s+(предпоследн|последн)[а-яё]*\\s+день\\s+месяца${E}`))) {
    rrule = `FREQ=MONTHLY;BYMONTHDAY=${m[1].toLowerCase().startsWith('пред') ? -2 : -1}`;
  }

  // «каждый первый понедельник месяца», «каждую последнюю пятницу месяца»
  else if (
    (m = eat(
      `${B}кажд[а-яё]*\\s+(перв|втор|трет|четв[её]рт|последн|предпоследн)[а-яё]*\\s+(${WD_ALT})[а-яё]*(?:\\s+месяца)?${E}`
    ))
  ) {
    const ord = ORDINALS.find(([re]) => re.test(m[1]))?.[1] ?? 1;
    rrule = `FREQ=MONTHLY;BYDAY=${ord}${WD_CODE(m[2])}`;
  }

  // «каждое 29 число», «29 числа каждого месяца», «каждый месяц 15 числа»
  else if (
    (m = eat(
      `${B}кажд[а-яё]*\\s+(?:месяц[а-яё]*\\s+)?(\\d{1,2})\\s*(?:-?[а-яё]{1,2})?\\s*числ[а-яё]*(?:\\s+месяца)?${E}`
    )) ||
    (m = eat(`${B}(\\d{1,2})\\s*числа\\s+кажд[а-яё]*\\s+месяца${E}`))
  ) {
    rrule = `FREQ=MONTHLY;BYMONTHDAY=${Number(m[1])}`;
  }

  // «по будням» / «по выходным»
  else if ((m = eat(`${B}(?:по\\s+будням|кажд[а-яё]*\\s+будн[а-яё]*)${E}`))) {
    rrule = 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR';
  } else if ((m = eat(`${B}по\\s+выходным${E}`))) {
    rrule = 'FREQ=WEEKLY;BYDAY=SA,SU';
  }

  // «каждые 2 недели», «каждые 3 дня»
  else if ((m = eat(`${B}кажд[а-яё]*\\s+(\\d+)\\s+(дн[а-яё]*|день|недел[а-яё]*|месяц[а-яё]*)${E}`))) {
    const n = Number(m[1]);
    const u = m[2].toLowerCase();
    const freq = u.startsWith('недел') ? 'WEEKLY' : u.startsWith('месяц') ? 'MONTHLY' : 'DAILY';
    rrule = `FREQ=${freq};INTERVAL=${n}`;
  }

  // «каждый вторник», «по вторникам», «каждый вторник и пятницу»
  else if ((m = eat(`${B}(?:кажд[а-яё]*|по)\\s+(${WD_ALT})[а-яё]*(?:\\s+и\\s+(${WD_ALT})[а-яё]*)?${E}`))) {
    const days = [WD_CODE(m[1]), m[2] ? WD_CODE(m[2]) : null].filter(Boolean);
    rrule = `FREQ=WEEKLY;BYDAY=${days.join(',')}`;
  }

  // Общие формы
  else if ((m = eat(`${B}(?:ежедневно|кажд[а-яё]*\\s+день)${E}`))) rrule = 'FREQ=DAILY';
  else if ((m = eat(`${B}(?:еженедельно|кажд[а-яё]*\\s+недел[а-яё]*)${E}`))) rrule = 'FREQ=WEEKLY';
  else if ((m = eat(`${B}(?:ежемесячно|кажд[а-яё]*\\s+месяц[а-яё]*)${E}`))) rrule = 'FREQ=MONTHLY';
  else if ((m = eat(`${B}(?:ежегодно|кажд[а-яё]*\\s+год[а-яё]*)${E}`))) rrule = 'FREQ=YEARLY';

  if (!rrule) return null;
  return { rrule, rest: text.replace(/\s+/g, ' ').trim() };
}

/** Есть ли в тексте намёк на повторение — для честного предупреждения, если распознать не вышло. */
export function looksRecurring(input) {
  return new RegExp(`${B}(кажд[а-яё]*|ежедневн|еженедельн|ежемесячн|ежегодн|по\\s+будням|по\\s+выходным)`, 'iu').test(
    input
  );
}

// --- описание правила по-русски -------------------------------------------

const WD_RU = { MO: 'понедельник', TU: 'вторник', WE: 'среду', TH: 'четверг', FR: 'пятницу', SA: 'субботу', SU: 'воскресенье' };
const WD_RU_PL = { MO: 'понедельникам', TU: 'вторникам', WE: 'средам', TH: 'четвергам', FR: 'пятницам', SA: 'субботам', SU: 'воскресеньям' };
const ORD_RU = { 1: 'первый', 2: 'второй', 3: 'третий', 4: 'четвёртый', '-1': 'последний', '-2': 'предпоследний' };

export function describeRrule(rule) {
  const parts = Object.fromEntries(
    rule.split(';').map((p) => {
      const [k, v] = p.split('=');
      return [k.toUpperCase(), v];
    })
  );
  const interval = Number(parts.INTERVAL || 1);

  if (parts.FREQ === 'DAILY') return interval === 1 ? 'ежедневно' : `каждые ${interval} дн.`;

  if (parts.FREQ === 'WEEKLY') {
    if (!parts.BYDAY) return interval === 1 ? 'еженедельно' : `каждые ${interval} нед.`;
    const days = parts.BYDAY.split(',');
    if (parts.BYDAY === 'MO,TU,WE,TH,FR') return 'по будням';
    if (parts.BYDAY === 'SA,SU') return 'по выходным';
    return 'по ' + days.map((d) => WD_RU_PL[d] || d).join(' и ');
  }

  if (parts.FREQ === 'MONTHLY') {
    if (parts.BYMONTHDAY) {
      const n = Number(parts.BYMONTHDAY);
      if (n === -1) return 'в последний день месяца';
      if (n === -2) return 'в предпоследний день месяца';
      return `${n} числа каждого месяца`;
    }
    if (parts.BYDAY) {
      const mm = /^(-?\d)?([A-Z]{2})$/.exec(parts.BYDAY);
      if (mm) return `каждый ${ORD_RU[mm[1] || 1] || mm[1]} ${WD_RU[mm[2]] || mm[2]} месяца`;
    }
    return interval === 1 ? 'ежемесячно' : `каждые ${interval} мес.`;
  }

  if (parts.FREQ === 'YEARLY') return 'ежегодно';
  return rule;
}

// --- расчёт вхождений -------------------------------------------------------

/**
 * RRule работает с «плавающими» датами в UTC. Чтобы время суток не ехало
 * при переходе на летнее время, генерируем по локальным стенным часам,
 * а результат собираем обратно уже в нужной таймзоне.
 */
function toFloating(dt) {
  return new Date(Date.UTC(dt.year, dt.month - 1, dt.day, dt.hour, dt.minute, 0));
}

function fromFloating(date, tz) {
  return DateTime.fromObject(
    {
      year: date.getUTCFullYear(),
      month: date.getUTCMonth() + 1,
      day: date.getUTCDate(),
      hour: date.getUTCHours(),
      minute: date.getUTCMinutes(),
    },
    { zone: tz }
  );
}

/** Вхождения правила в окне [from, to] с учётом коротких месяцев. */
export function occurrencesBetween(rec, from, to) {
  const tz = rec.tz || TZ;
  const startLocal = DateTime.fromJSDate(new Date(rec.dtstart), { zone: tz });

  const set = rrulestr(`DTSTART:${toFloating(startLocal).toISOString().replace(/[-:]|\.\d{3}/g, '')}
RRULE:${rec.rrule}`);

  const dates = set
    .between(toFloating(DateTime.fromJSDate(from, { zone: tz })), toFloating(DateTime.fromJSDate(to, { zone: tz })), true)
    .map((d) => fromFloating(d, tz));

  // Короткие месяцы: BYMONTHDAY=29..31 RRULE просто пропускает.
  const bymd = /BYMONTHDAY=(\d+)/i.exec(rec.rrule);
  if (rec.month_end_fallback && bymd && Number(bymd[1]) >= 29) {
    const wanted = Number(bymd[1]);
    let cursor = DateTime.fromJSDate(from, { zone: tz }).startOf('month');
    const end = DateTime.fromJSDate(to, { zone: tz });
    while (cursor <= end) {
      if (cursor.daysInMonth < wanted) {
        const candidate = cursor.set({
          day: cursor.daysInMonth,
          hour: startLocal.hour,
          minute: startLocal.minute,
          second: 0,
          millisecond: 0,
        });
        if (candidate >= DateTime.fromJSDate(from, { zone: tz }) && candidate <= end) {
          dates.push(candidate);
        }
      }
      cursor = cursor.plus({ months: 1 });
    }
  }

  return dates.sort((a, b) => a - b).map((d) => d.toJSDate());
}

/** Ближайшее вхождение начиная с now — используется при создании правила. */
export function firstOccurrence(rec, now = new Date()) {
  const to = DateTime.fromJSDate(now).plus({ years: 2 }).toJSDate();
  return occurrencesBetween(rec, now, to)[0] || null;
}

// --- материализация ---------------------------------------------------------

export async function materializeRecurrence(rec) {
  const from = new Date();
  const to = DateTime.now().plus({ days: HORIZON_DAYS }).toJSDate();
  let created = 0;

  for (const occ of occurrencesBetween(rec, from, to)) {
    const occurrenceStart = occ.toISOString();

    await withTx(async (c) => {
      const { rows } = await c.query(
        `insert into tasks
           (title, notes, due_at, is_all_day, tz, assignee_id, creator_id, chat_id, thread_id,
            offsets, source, external_id, occurrence_start, recurrence_id)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'recur',$11,$12,$13)
         on conflict do nothing
         returning id`,
        [
          rec.title,
          rec.notes,
          occ,
          rec.is_all_day,
          rec.tz,
          rec.assignee_id,
          rec.creator_id,
          rec.chat_id,
          rec.thread_id,
          JSON.stringify(rec.offsets),
          String(rec.id),
          occurrenceStart,
          rec.id,
        ]
      );
      if (rows.length) {
        created++;
        await regenerateReminders(rows[0].id, c);
      }
    });
  }

  await q('update recurrences set last_run_at = now() where id = $1', [rec.id]);
  return created;
}

export async function materializeAll() {
  const { rows } = await q('select * from recurrences where active = true');
  let total = 0;
  for (const rec of rows) {
    try {
      total += await materializeRecurrence(rec);
    } catch (e) {
      console.error(`[recur] правило #${rec.id} упало:`, e.message);
    }
  }
  if (total) console.log(`[recur] создано задач: ${total}`);
  return total;
}

/** Отключить правило и снять ещё не наступившие задачи по нему. */
export async function deactivateRecurrence(id) {
  const { rows } = await q(
    `update recurrences set active = false where id = $1 returning *`,
    [id]
  );
  if (!rows.length) return null;

  const { rows: future } = await q(
    `update tasks set status='cancelled', updated_at=now()
      where recurrence_id = $1 and status='pending' and due_at > now()
      returning id`,
    [id]
  );
  for (const t of future) await cancelReminders(t.id);
  return { recurrence: rows[0], cancelled: future.length };
}

export { RRule };
