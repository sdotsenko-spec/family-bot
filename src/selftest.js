/**
 * Оффлайн-проверка парсера и офсетов. БД и Telegram не нужны:
 *   node src/selftest.js
 */
// parser.js тянет learning.js → db.js, которому нужен DATABASE_URL.
// Поэтому переменную выставляем ДО импортов, а сами импорты делаем
// динамическими: статические поднимаются наверх и сработали бы раньше.
process.env.DATABASE_URL ||= 'postgresql://localhost:5432/selftest';

const { parseFallback } = await import('./parser.js');
const { offsetToMs, humanOffset, DateTime, TZ } = await import('./time.js');

const NOW = DateTime.fromISO('2026-07-26T14:00:00', { zone: TZ }); // воскресенье

const cases = [
  'завтра в 18:30 забрать посылку с почты',
  'в среду вечером записать ребёнка к врачу, напомни за сутки и за 2 часа',
  '5 августа годовщина, напомни за неделю',
  'через 2 часа снять бельё',
  '12.08 в 9:00 техосмотр',
  'купить корм коту', // без даты и без напоминаний → дело без срока
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
  // Дело без срока — валидный исход: dueAt = null
  const ok = r.dueAt === null
    ? r.isInbox === true && r.title.length > 0
    : due.isValid && due >= NOW.minus({ minutes: 1 }) && r.title.length > 0;
  if (!ok) failures++;
  console.log(
    `${ok ? '✓' : '✗'} ${text}\n    → «${r.title}» @ ${r.dueAt === null ? 'без срока (инбокс)' : due.toFormat('ccc dd.MM HH:mm')}` +
      `${r.dueAt !== null && r.isAllDay ? ' (весь день)' : ''}` +
      `${r.offsets.length ? ' | ' + r.offsets.map(humanOffset).join(', ') : ''}` +
      `${r.assigneeUsername ? ' | @' + r.assigneeUsername : ''}`
  );
}

// Оговорки про напоминания: интервалы, количество, абсолютные времена
console.log('\n— оговорки «напомни …» —');
for (const [text, wantTime, wantOffsets] of [
  ['сфоткать счетчики, напомни в 9 и 19', '19:00', ['10h']],
  ['сфоткать счетчики, напомни в 9:00 и в 19:00', '19:00', ['10h']],
  ['в 19:00 сфоткать счетчики, напомни в 9:00', '19:00', ['10h']],
  ['напомни 2 раза полить цветы завтра в 15:00', '15:00', ['24h', '30m']],
  ['завтра забрать посылку, напомни в 8:00 и в 12:00', '12:00', ['4h']],
  ['купить хлеб, напомни за сутки и за 2 часа', '09:00', ['24h', '2h']],
  ['напомни за час купить хлеб', '09:00', ['1h']],
  // «5.08» — дата, а не время 5:08
  ['Напомни 12.08 в 9:10 набрать Димона. Напомни в 9:10', '09:10', []],
]) {
  const r = parseFallback(text, TZ, NOW);
  const got = DateTime.fromJSDate(r.dueAt).setZone(TZ).toFormat('HH:mm');
  check2(`«${text}»`, [got, r.offsets], [wantTime, wantOffsets]);
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

  check('личная задача — только в свою личку, без пинга и эскалации',
    chats(chooseTargets({ reminder: { label: '3h', task_id: 1 }, task: { ...base, is_private: true, chat_id: DM }, assignee: wife, familyChatId: GROUP })),
    [DM]);

  check('личная задача: эскалация тоже не в группу',
    chats(chooseTargets({ reminder: { label: 'escalation', task_id: 1 }, task: { ...base, is_private: true, chat_id: DM }, assignee: wife, familyChatId: GROUP })),
    [DM]);

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
  check2('десятичная запятая не рвёт пункт',
    splitItems('Мясо на фарш 1,5 кг\nМолоко 2 л.'), ['Мясо на фарш 1,5 кг', 'Молоко 2 л.']);
  check2('запятая-разделитель перед числом работает',
    splitItems('молоко, 2 яйца, хлеб'), ['молоко', '2 яйца', 'хлеб']);
  check2('несколько десятичных в строке',
    splitItems('сыр 0,5 кг, масло 1,2 кг'), ['сыр 0,5 кг', 'масло 1,2 кг']);

  // Страховка от того, что задача молча уедет в покупки
  const { looksLikeTask } = await import('./shopping.js');
  for (const [t, want] of [
    ['Завтра в 14:00 собеседование. Напомни за час', true],
    ['через 2 часа позвонить маме', true],
    ['каждый вторник вынести мусор', true],
    ['молоко, хлеб, памперсы', false],
    ['памперсы 4 размер', false],
    ['сыр пармезан 200 г', false],
    // Настоящий список из чата: длинный, многострочный, с количествами
    [
      'Сок яблочный\nСметана\nМоцарелла 2 шт.\nМолоко 2 л.\nКартошка 3 кг.\nЯблоки\n' +
        'Памперсы (kindii)\nНектарин 2 шт.\nБолгарский перец красный 1шт\n' +
        'Перец для фаршировки 10 шт.\nЛук\nБедро 4 шт.\nМясо на фарш 1,5 кг',
      false,
    ],
  ]) {
    const label = t.length > 40 ? t.slice(0, 37).replace(/\n/g, ' ') + '…' : t;
    check2(`«${label}» → ${want ? 'задача' : 'покупка'}`, looksLikeTask(t), want);
  }
}

// --- счётчики ---------------------------------------------------------------
{
  const { extractNumbers, isMeterTask } = await import('./meters.js');
  check2('числа из свободного текста', extractNumbers('вода 1234,5 свет 567'), [1234.5, 567]);
  check2('ведущие нули и точка', extractNumbers('001234.750, 000876'), [1234.75, 876]);
  check2('нет чисел', extractNumbers('нет чисел тут'), []);
  check2('«сфоткать счетчики» → задача про счётчики', isMeterTask('сфоткать счетчики'), true);
  check2('«купить хлеб» → не про счётчики', isMeterTask('купить хлеб'), false);

  // Дата снятия: вырезается ДО поиска чисел, иначе «29.07» станет показанием
  const { extractDate } = await import('./meters.js');
  const d1 = extractDate('1250 876 5670 за 29.07', TZ, NOW);
  check2('дата за 29.07 распознана', d1.at && d1.at.toFormat('dd.MM'), '29.07');
  check2('дата не попала в показания', extractNumbers(d1.rest), [1250, 876, 5670]);
  const d2 = extractDate('1250,5 29 июля', TZ, NOW);
  check2('дата словами', d2.at && d2.at.toFormat('dd.MM'), '29.07');
  check2('показание с запятой уцелело', extractNumbers(d2.rest), [1250.5]);
  const d3 = extractDate('1250 876', TZ, NOW);
  check2('без даты — null', d3.at, null);

  // Многотарифные приборы
  const { displayName, PRESET } = await import('./meters.js');
  check2('имя с группой', displayName({ name: 'День', group_name: 'Электричество' }),
    'Электричество · День');
  check2('имя без группы', displayName({ name: 'Вода холодная', group_name: null }),
    'Вода холодная');
  check2('в типовом наборе есть день/ночь/общий',
    PRESET.filter(([n]) => n.startsWith('Электричество/')).map(([n]) => n.split('/')[1]),
    ['День', 'Ночь', 'Общий']);
}

// --- коммуналка: сверка модели с реальными платёжками ----------------------
{
  const { SETUP } = await import('./billing.js');

  // Актуальная цена позиции на дату — та же логика, что в chargesAt
  const rateAt = (provider, name, onDate) => {
    const rows = SETUP.filter(
      (c) => c.provider === provider && c.name === name && (c.validFrom || '2026-04-01') <= onDate
    );
    return rows.length ? rows[rows.length - 1].rate : null;
  };

  const compute = ({ onDate, hv, gv, te, day, night }) => {
    const r = (p, n) => rateAt(p, n, onDate);
    return (
      r('Квартплата', 'Утримання буд.') +
      r('Квартплата', 'Охорона') +
      r('Квартплата', 'Відеоспостереження') +
      hv * r('Киевводоканал', 'Постачання ХВ') +
      r('Киевводоканал', 'Абонентське обсл.') +
      gv * r('Киевводоканал', 'Водовідведення ГВ') +
      gv * r('Гаряча вода', 'Постачання ГВ') +
      r('Гаряча вода', 'Абонентське обсл.') +
      te * r('Теплова енергія', 'ТЕ (ЦО) з ФСГ') +
      r('Теплова енергія', 'Абонентське обсл.') +
      day * r('Електроенергія', 'День') +
      night * r('Електроенергія', 'Ніч')
    );
  };

  // Апрель 2026: платёжка 8472 грн
  const april = compute({ onDate: '2026-04-30', hv: 10.23, gv: 20.169, te: 34.41 / 1654.41, day: 718, night: 306 });
  check2('апрель сходится с платёжкой (±2 грн)', Math.abs(april - 8472) < 2, true);

  // Июль 2026: платёжка 5907 грн, абонплаты уже новые (с июня)
  const july = compute({ onDate: '2026-07-31', hv: 11.5, gv: 12, te: 20.27 / 1654.41, day: 400, night: 166 });
  check2('июль сходится с платёжкой (±2 грн)', Math.abs(july - 5907) < 2, true);

  // Июнь: абонплата ГВ уже 30.6, а не 29.3
  check2('абонплата ГВ до июня', rateAt('Гаряча вода', 'Абонентське обсл.', '2026-05-31'), 29.3);
  check2('абонплата ГВ с июня', rateAt('Гаряча вода', 'Абонентське обсл.', '2026-06-15'), 30.6);
  check2('абонплата ТЕ с июня', rateAt('Теплова енергія', 'Абонентське обсл.', '2026-07-01'), 43.39);

  // Электричество считаем отдельно — там цифры в платёжках точные до копейки
  check2('электричество апрель', Number((718 * 4.32 + 306 * 2.16).toFixed(2)), 3762.72);
  check2('электричество июль', Number((400 * 4.32 + 166 * 2.16).toFixed(2)), 2086.56);
}

// --- контракт разбора: несколько задач, долбёжка, вопрос -------------------
{
  const { parseTask, MIN_NAG_MINUTES } = await import('./parser.js');

  // Без ключа работает фолбэк — он всегда отдаёт ровно одну задачу,
  // но в том же формате, что и модель
  delete process.env.ANTHROPIC_API_KEY;
  const r = await parseTask('завтра в 18:30 забрать посылку');
  check2('фолбэк отдаёт массив задач', Array.isArray(r.tasks), true);
  check2('фолбэк не задаёт вопросов', r.question, null);
  check2('фолбэк — ровно одна задача', r.tasks.length, 1);
  check2('заголовок разобран', r.tasks[0].title, 'забрать посылку');
  check2('минимальный период долбёжки — час', MIN_NAG_MINUTES, 60);
}

// --- дела без срока ---------------------------------------------------------
{
  const inbox = parseFallback('купить стеллаж', TZ, NOW);
  check2('дело без даты попадает в инбокс', [inbox.isInbox, inbox.dueAt], [true, null]);

  const dated = parseFallback('завтра в 18:30 забрать посылку', TZ, NOW);
  check2('дело с датой в инбокс не попадает', dated.isInbox, false);

  // Смещения подразумевают дедлайн — такое остаётся обычной задачей
  const withOffsets = parseFallback('купить хлеб, напомни за сутки', TZ, NOW);
  check2('смещения без даты → не инбокс', withOffsets.isInbox, false);
}

console.log(failures ? `\n${failures} провалов` : '\nВсё зелёное');
process.exit(failures ? 1 : 0);
