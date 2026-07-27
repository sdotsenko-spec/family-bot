/**
 * Оффлайн-проверка парсера и офсетов. БД и Telegram не нужны:
 *   node src/selftest.js
 */
import { parseFallback } from './parser.js';
import { offsetToMs, humanOffset, DateTime, TZ } from './time.js';

const NOW = DateTime.fromISO('2026-07-26T14:00:00', { zone: TZ }); // воскресенье

const cases = [
  'завтра в 18:30 забрать посылку с почты',
  'в среду вечером записать ребёнка к врачу, напомни за сутки и за 2 часа',
  '5 августа годовщина, напомни за неделю',
  'через 2 часа снять бельё',
  '12.08 в 9:00 техосмотр',
  'купить корм коту',
  'в 7:00 разбудить всех',
  'послезавтра оплатить интернет @serhii',
];

let failures = 0;

for (const text of cases) {
  const r = parseFallback(text, TZ, NOW);
  const due = DateTime.fromJSDate(r.dueAt).setZone(TZ);
  const ok = due.isValid && due >= NOW.minus({ minutes: 1 }) && r.title.length > 0;
  if (!ok) failures++;
  console.log(
    `${ok ? '✓' : '✗'} ${text}\n    → «${r.title}» @ ${due.toFormat('ccc dd.MM HH:mm')}` +
      `${r.isAllDay ? ' (весь день)' : ''}` +
      `${r.offsets.length ? ' | ' + r.offsets.map(humanOffset).join(', ') : ''}` +
      `${r.assigneeUsername ? ' | @' + r.assigneeUsername : ''}`
  );
}

console.log('\n— офсеты —');
for (const [label, expected] of [
  ['24h', 86_400_000],
  ['30m', 1_800_000],
  ['2d', 172_800_000],
  ['мусор', null],
]) {
  const got = offsetToMs(label);
  const ok = got === expected;
  if (!ok) failures++;
  console.log(`${ok ? '✓' : '✗'} ${label} → ${got}`);
}

console.log(failures ? `\n${failures} провалов` : '\nВсё зелёное');
process.exit(failures ? 1 : 0);
