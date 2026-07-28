import { DateTime, Duration } from 'luxon';

export const TZ = process.env.FAMILY_TZ || 'Europe/Kyiv';

// Во сколько «звонит» задача без конкретного времени (all-day).
// Ключевой момент: если считать «за сутки» от 00:00, напоминание прилетит
// в полночь предыдущего дня. Поэтому опорная точка — утро.
export const ALL_DAY_HOUR = Number(process.env.ALL_DAY_HOUR || 9);

const OFFSET_RE = /^(\d+)\s*(m|min|h|d|w)$/i;

/** '24h' | '90m' | '2d' -> миллисекунды */
export function offsetToMs(label) {
  const m = OFFSET_RE.exec(String(label).trim());
  if (!m) return null;
  const n = Number(m[1]);
  switch (m[2].toLowerCase()) {
    case 'm':
    case 'min':
      return n * 60_000;
    case 'h':
      return n * 3_600_000;
    case 'd':
      return n * 86_400_000;
    case 'w':
      return n * 7 * 86_400_000;
    default:
      return null;
  }
}

export function humanOffset(label) {
  const map = {
    '1w': 'за неделю',
    '3d': 'за 3 дня',
    '2d': 'за 2 дня',
    '1d': 'за сутки',
    '24h': 'за сутки',
    '14d': 'за две недели',
    '7d': 'за неделю',
    '48h': 'за двое суток',
    '12h': 'за 12 часов',
    '6h': 'за 6 часов',
    '3h': 'за 3 часа',
    '2h': 'за 2 часа',
    '1h': 'за час',
    '30m': 'за 30 минут',
    '15m': 'за 15 минут',
    '10m': 'за 10 минут',
    escalation: 'просрочено',
  };
  if (map[label]) return map[label];
  const ms = offsetToMs(label);
  if (!ms) return label;
  return 'за ' + Duration.fromMillis(ms).rescale().setLocale('ru').toHuman({ maximumFractionDigits: 0 });
}

export function nowIn(tz = TZ) {
  return DateTime.now().setZone(tz);
}

export function fmt(dt, tz = TZ, allDay = false) {
  const d = DateTime.isDateTime(dt) ? dt.setZone(tz) : DateTime.fromJSDate(dt, { zone: tz });
  const today = nowIn(tz).startOf('day');
  const dayDiff = d.startOf('day').diff(today, 'days').days;

  let dayLabel;
  if (dayDiff === 0) dayLabel = 'сегодня';
  else if (dayDiff === 1) dayLabel = 'завтра';
  else if (dayDiff === 2) dayLabel = 'послезавтра';
  else if (dayDiff === -1) dayLabel = 'вчера';
  else dayLabel = d.setLocale('ru').toFormat('d MMMM (ccc)');

  return allDay ? dayLabel : `${dayLabel} в ${d.toFormat('HH:mm')}`;
}

/** Дата дедлайна для all-day события: тот же день, но в ALL_DAY_HOUR по локали. */
export function anchorAllDay(jsDate, tz = TZ) {
  const d = DateTime.fromJSDate(jsDate, { zone: 'utc' });
  return DateTime.fromObject(
    { year: d.year, month: d.month, day: d.day, hour: ALL_DAY_HOUR },
    { zone: tz }
  ).toJSDate();
}

export { DateTime };
