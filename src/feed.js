import crypto from 'node:crypto';
import { q, getSetting, setSetting } from './db.js';
import { DateTime, TZ } from './time.js';

// Окно выгрузки: немного назад, чтобы недавнее не пропадало из вида
const PAST_DAYS = 30;
const FUTURE_DAYS = 365;

/** Секрет в ссылке. Другой защиты нет — ссылку нельзя показывать посторонним. */
export async function feedToken() {
  let token = await getSetting('calendar_token');
  if (!token) {
    token = crypto.randomBytes(16).toString('hex');
    await setSetting('calendar_token', token);
  }
  return token;
}

/** Экранирование по RFC 5545: запятая, точка с запятой, слэш и перевод строки. */
function esc(text) {
  return String(text ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

/** Строки длиннее 75 октетов положено сворачивать, иначе часть парсеров ломается. */
function fold(line) {
  const bytes = Buffer.from(line, 'utf8');
  if (bytes.length <= 75) return line;

  const out = [];
  let chunk = '';
  let size = 0;
  for (const ch of line) {
    const chSize = Buffer.byteLength(ch, 'utf8');
    if (size + chSize > (out.length ? 74 : 75)) {
      out.push(chunk);
      chunk = '';
      size = 0;
    }
    chunk += ch;
    size += chSize;
  }
  if (chunk) out.push(chunk);
  return out.join('\r\n ');
}

const utc = (d) => DateTime.fromJSDate(d).toUTC().toFormat("yyyyLLdd'T'HHmmss'Z'");
const dateOnly = (d, tz) => DateTime.fromJSDate(d).setZone(tz).toFormat('yyyyLLdd');

function event({ uid, start, end, allDay, tz, summary, description, rrule, stamp }) {
  const lines = [
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTAMP:${stamp}`,
  ];

  if (allDay) {
    lines.push(`DTSTART;VALUE=DATE:${dateOnly(start, tz)}`);
    lines.push(`DTEND;VALUE=DATE:${dateOnly(end, tz)}`);
  } else {
    lines.push(`DTSTART:${utc(start)}`);
    lines.push(`DTEND:${utc(end)}`);
  }

  if (rrule) lines.push(`RRULE:${rrule}`);
  lines.push(`SUMMARY:${esc(summary)}`);
  if (description) lines.push(`DESCRIPTION:${esc(description)}`);
  lines.push('END:VEVENT');
  return lines;
}

/**
 * Собирает подписной календарь.
 * Задачи, импортированные ИЗ календарей, наружу не отдаём — иначе события
 * вернулись бы в тот же календарь вторым экземпляром.
 */
export async function buildFeed() {
  const now = DateTime.now();
  const from = now.minus({ days: PAST_DAYS }).toJSDate();
  const to = now.plus({ days: FUTURE_DAYS }).toJSDate();
  const stamp = utc(new Date());

  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//family-bot//RU',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'X-WR-CALNAME:Семейные задачи',
    `X-WR-TIMEZONE:${TZ}`,
  ];

  // Разовые задачи (и не пришедшие из календарей)
  const { rows: tasks } = await q(
    `select t.*, u.name as assignee_name
       from tasks t left join users u on u.id = t.assignee_id
      where t.status = 'pending'
        and t.source <> 'ics'
        and t.recurrence_id is null
        and t.due_at between $1 and $2
      order by t.due_at`,
    [from, to]
  );

  for (const t of tasks) {
    const start = new Date(t.due_at);
    const end = t.is_all_day
      ? DateTime.fromJSDate(start).plus({ days: 1 }).toJSDate()
      : DateTime.fromJSDate(start).plus({ hours: 1 }).toJSDate();
    lines.push(
      ...event({
        uid: `task-${t.id}@family-bot`,
        start,
        end,
        allDay: t.is_all_day,
        tz: t.tz || TZ,
        summary: t.title,
        description: t.assignee_name ? `Исполнитель: ${t.assignee_name}` : null,
        stamp,
      })
    );
  }

  // Повторяющиеся отдаём правилом, а не тридцатью копиями:
  // календарь развернёт их сам и на годы вперёд
  const { rows: recurrences } = await q(
    `select r.*, u.name as assignee_name
       from recurrences r left join users u on u.id = r.assignee_id
      where r.active = true`
  );

  for (const r of recurrences) {
    const start = new Date(r.dtstart);
    const end = r.is_all_day
      ? DateTime.fromJSDate(start).plus({ days: 1 }).toJSDate()
      : DateTime.fromJSDate(start).plus({ hours: 1 }).toJSDate();
    lines.push(
      ...event({
        uid: `recur-${r.id}@family-bot`,
        start,
        end,
        allDay: r.is_all_day,
        tz: r.tz || TZ,
        summary: r.title,
        description: r.assignee_name ? `Исполнитель: ${r.assignee_name}` : null,
        rrule: r.rrule,
        stamp,
      })
    );
  }

  lines.push('END:VCALENDAR');
  return lines.map(fold).join('\r\n') + '\r\n';
}

/** Публичный адрес сервиса — Railway отдаёт его в переменной окружения. */
export function publicUrl() {
  const domain = process.env.PUBLIC_URL || process.env.RAILWAY_PUBLIC_DOMAIN;
  if (!domain) return null;
  return domain.startsWith('http') ? domain.replace(/\/$/, '') : `https://${domain}`;
}
