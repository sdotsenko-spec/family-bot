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

const check2 = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) { failures++; console.log(`✗ ${name}\n    получили ${JSON.stringify(got)}\n    ждали   ${JSON.stringify(want)}`); }
  else console.log(`✓ ${name}`);
};

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


// --- маршрутизация напоминаний ---------------------------------------------
{
  // reminders.js тянет db.js, которому нужен DATABASE_URL. Пул создаётся,
  // но никуда не подключается — для чистой функции этого достаточно.
  process.env.DATABASE_URL ||= 'postgresql://localhost:5432/selftest';
  const { chooseTargets } = await import('./reminders.js');
  const GROUP = -1001111111111;
  const DM = 555000111;
  const base = {
    id: 1, title: 'Забрать посылку', due_at: new Date(Date.now() + 3600e3),
    is_all_day: false, tz: TZ, source: 'bot', notes: null,
    chat_id: GROUP, thread_id: null, dm_chat_id: DM, assignee_id: 7,
  };
  const wife = { tg_user_id: 42, tg_username: 'serhii', name: 'Сергей' };

  const check = (name, got, want) => {
    const ok = JSON.stringify(got) === JSON.stringify(want);
    if (!ok) { failures++; console.log(`✗ ${name}\n    получили ${JSON.stringify(got)}\n    ждали   ${JSON.stringify(want)}`); }
    else console.log(`✓ ${name}`);
  };

  const chats = (t) => t.map((x) => x.chat);

  check('в личку + пинг в группу',
    chats(chooseTargets({ reminder: { label: '3h', task_id: 1 }, task: base, assignee: wife, familyChatId: GROUP })),
    [DM, GROUP]);

  check('без исполнителя — только в чат задачи',
    chats(chooseTargets({ reminder: { label: '3h', task_id: 1 }, task: { ...base, assignee_id: null }, assignee: null, familyChatId: GROUP })),
    [GROUP]);

  check('исполнитель без лички — в чат задачи с подсказкой',
    chats(chooseTargets({ reminder: { label: '3h', task_id: 1 }, task: { ...base, dm_chat_id: null }, assignee: wife, familyChatId: GROUP })),
    [GROUP]);

  check('эскалация — только в общий чат',
    chats(chooseTargets({ reminder: { label: 'escalation', task_id: 1 }, task: base, assignee: wife, familyChatId: GROUP })),
    [GROUP]);

  check('задача создана в личке — без дубля',
    chats(chooseTargets({ reminder: { label: '3h', task_id: 1 }, task: { ...base, chat_id: DM }, assignee: wife, familyChatId: null })),
    [DM]);

  const hinted = chooseTargets({ reminder: { label: '3h', task_id: 1 }, task: { ...base, dm_chat_id: null }, assignee: wife, familyChatId: GROUP });
  check('подсказка про /start присутствует', hinted[0].text.includes('/start'), true);

  const pinged = chooseTargets({ reminder: { label: '3h', task_id: 1 }, task: base, assignee: wife, familyChatId: GROUP });
  check('пинг без кнопок', pinged[1].keyboard, false);
  check('пинг содержит упоминание', pinged[1].text.includes('@serhii'), true);
  check('пинг НЕ раскрывает название задачи', pinged[1].text.includes('Забрать посылку'), false);
  check('пинг НЕ раскрывает время', /\d{1,2}:\d{2}/.test(pinged[1].text), false);
}

// --- повторяющиеся задачи ---------------------------------------------------
{
  const { parseRecurrence, describeRrule, occurrencesBetween, looksRecurring } =
    await import('./recurrence.js');

  const fmtOcc = (list) =>
    list.map((d) => DateTime.fromJSDate(d).setZone(TZ).toFormat('dd.MM HH:mm'));

  const rules = [
    ['каждый вторник в 20:00 вынести мусор', 'FREQ=WEEKLY;BYDAY=TU', 'вынести мусор'],
    ['по будням в 7:30 разбудить детей', 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR', 'разбудить детей'],
    ['каждое 29 число оплатить кредит', 'FREQ=MONTHLY;BYMONTHDAY=29', 'оплатить кредит'],
    ['каждый предпоследний день месяца сдать отчёт', 'FREQ=MONTHLY;BYMONTHDAY=-2', 'сдать отчёт'],
    ['каждый первый понедельник месяца планёрка', 'FREQ=MONTHLY;BYDAY=1MO', 'планёрка'],
    ['каждые 2 недели полить цветы', 'FREQ=WEEKLY;INTERVAL=2', 'полить цветы'],
    ['каждый вторник и пятницу тренировка', 'FREQ=WEEKLY;BYDAY=TU,FR', 'тренировка'],
    ['ежедневно в 22:00 таблетки', 'FREQ=DAILY', 'таблетки'],
  ];

  for (const [text, wantRule, wantTitleFragment] of rules) {
    const r = parseRecurrence(text);
    const ok = r && r.rrule === wantRule && r.rest.includes(wantTitleFragment);
    if (!ok) { failures++; console.log(`✗ ${text}\n    → ${r ? r.rrule + ' | «' + r.rest + '»' : 'не распознано'}`); }
    else console.log(`✓ ${describeRrule(r.rrule).padEnd(32)} ← ${text}`);
  }

  const noRule = parseRecurrence('завтра в 18:00 забрать посылку');
  check2('разовая задача не считается повторяющейся', noRule, null);
  check2('намёк на повтор ловится', looksRecurring('каждый третий четверг что-то'), true);

  // Короткий месяц: 29 числа в феврале 2027 (28 дней) — должно упасть на 28-е
  const feb = fmtOcc(
    occurrencesBetween(
      { tz: TZ, month_end_fallback: true, rrule: 'FREQ=MONTHLY;BYMONTHDAY=29',
        dtstart: new Date('2026-12-29T20:00:00+02:00') },
      new Date('2027-02-01'), new Date('2027-03-05')
    )
  );
  check2('февраль без 29-го → последний день месяца', feb, ['28.02 20:00']);

  // Переход на летнее время: стенное время не должно уехать
  const dst = fmtOcc(
    occurrencesBetween(
      { tz: TZ, month_end_fallback: true, rrule: 'FREQ=WEEKLY;BYDAY=TU',
        dtstart: new Date('2027-03-16T20:00:00+02:00') },
      new Date('2027-03-16'), new Date('2027-04-07')
    )
  );
  check2('время суток переживает переход на летнее время',
    dst, ['16.03 20:00', '23.03 20:00', '30.03 20:00', '06.04 20:00']);
}

// --- список покупок ---------------------------------------------------------
{
  const { splitItems } = await import('./shopping.js');
  check2('разбор списка через запятую и перевод строки',
    splitItems('молоко, хлеб 2 шт\n- сыр;  '), ['молоко', 'хлеб 2 шт', 'сыр']);
  check2('пустые строки отбрасываются', splitItems(' , ,\n\n '), []);
  check2('маркеры списка срезаются', splitItems('• яблоки\n— груши'), ['яблоки', 'груши']);
}

console.log(failures ? `\n${failures} провалов` : '\nВсё зелёное');
process.exit(failures ? 1 : 0);
