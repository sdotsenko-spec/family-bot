import { DateTime, TZ, ALL_DAY_HOUR } from './time.js';
import { examplesBlock } from './learning.js';

/**
 * Разбирает фразу вида «завтра в 18:30 забрать посылку, напомни за день и за 2 часа»
 * в { title, dueAt, isAllDay, offsets, assigneeUsername }.
 *
 * Сначала пробуем Claude (если задан ANTHROPIC_API_KEY) — он вывозит кривые
 * формулировки. Если ключа нет или API упал — работает регексповый фолбэк,
 * его достаточно для 90% бытовых фраз.
 */
// Чаще раза в час не долбим ничем и никогда — иначе бота выключат
export const MIN_NAG_MINUTES = 60;

/**
 * Возвращает { tasks: [...], question: string|null }.
 * Задач может быть несколько: «разбей на 4 отдельных» — рабочая формулировка.
 * question заполняется, когда модель не уверена и лучше переспросить,
 * чем угадать: молчаливая догадка обходится дороже лишнего вопроса.
 */
export async function parseTask(text, { tz = TZ, now = DateTime.now().setZone(TZ) } = {}) {
  if (process.env.ANTHROPIC_API_KEY) {
    try {
      const viaLlm = await parseWithClaude(text, tz, now);
      if (viaLlm) return viaLlm;
    } catch (e) {
      console.warn('[parser] Claude недоступен, фолбэк:', e.message);
    }
  }
  // Регулярки нескольких задач не умеют — отдают одну, но в том же формате
  return { tasks: [parseFallback(text, tz, now)], question: null };
}

// --- LLM --------------------------------------------------------------------

const MODEL = process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001';

async function parseWithClaude(text, tz, now) {
  // Примеры из исправлений: чем дольше живёт бот, тем точнее разбор
  let learned = '';
  try {
    learned = await examplesBlock();
  } catch (e) {
    console.warn('[parser] примеры недоступны:', e.message);
  }

  const system = `Ты парсер бытовых задач. Отвечай ТОЛЬКО валидным JSON, без markdown и пояснений.

Схема ответа:
{"tasks": Task[], "question": string|null}

Task:
{"title": string, "due_at": string|null, "is_all_day": boolean, "offsets": string[],
 "assignee": string|null, "nag": {"every_minutes": number, "from": "HH:MM", "to": "HH:MM"}|null}

- В одном сообщении может быть НЕСКОЛЬКО задач: нумерованный или маркированный
  список, либо прямая просьба «разбей на N отдельных» — верни их отдельными
  элементами tasks, у каждого свой title.
- due_at — ISO 8601 со смещением, в таймзоне ${tz}
- ЕСЛИ СРОКА НЕТ ВООБЩЕ — due_at: null. Это дела «когда-нибудь»: купить стеллаж,
  заказать полку, разобрать балкон. НЕ выдумывай им дату: задача будет просто
  висеть и напоминать о себе, пока её не закроют.
- если назван день, но не время — is_all_day=true, due_at на ${ALL_DAY_HOUR}:00 этого дня
- offsets — интервалы ДО срока, вида ["24h","3h","30m"]; если не просили — []
- если названо только КОЛИЧЕСТВО напоминаний ("напоминай 2 раза"): 1 → ["30m"], 2 → ["24h","30m"], 3 → ["24h","3h","30m"]
- nag — для формулировок «напоминать раз в N часов», «висеть весь день, пока не
  отмечу», «долби с 11 до 19». every_minutes — период, from/to — окно суток.
  Если окно не названо, бери 09:00–21:00. Во всех прочих случаях nag=null.
- любое явно указанное время суток ВСЕГДА попадает в due_at, is_all_day=false
- assignee — telegram-username без @, если задача явно на кого-то; иначе null
- title — короткий, без даты/времени/слов про напоминания

question — задай его, если формулировка допускает разные прочтения и ошибка
дорого обойдётся: непонятно, одна это задача или несколько; не ясен день;
непонятно, на кого. Если спрашиваешь — верни tasks: [] и текст вопроса.
Не переспрашивай в очевидных случаях.

Сейчас: ${now.toISO()} (${tz}).${learned}`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODEL,
      // Хватает на список задач: одна задача ~100 токенов, а «разбей на 4»
      // в старые 400 не влезало — JSON обрывался и всё падало в фолбэк
      max_tokens: 2000,
      system,
      messages: [{ role: 'user', content: text }],
    }),
  });

  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();

  // Обрыв по лимиту даёт невалидный JSON, и без этой проверки причина
  // выглядела бы как «модель вернула чушь»
  if (data.stop_reason === 'max_tokens') {
    throw new Error('ответ обрезан по max_tokens');
  }
  const raw = (data.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .replace(/```json|```/g, '')
    .trim();

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`невалидный JSON: ${raw.slice(0, 120)}`);
  }

  if (parsed.question && (!parsed.tasks || !parsed.tasks.length)) {
    return { question: String(parsed.question).trim(), tasks: [] };
  }

  const list = Array.isArray(parsed.tasks) ? parsed.tasks : parsed.title ? [parsed] : [];
  if (!list.length) return null;

  const tasks = list
    .filter((t) => t && t.title)
    .map((t) => {
      const due = t.due_at ? DateTime.fromISO(t.due_at, { zone: tz }) : null;
      return {
        title: String(t.title).trim(),
        dueAt: due ? due.toJSDate() : null,
        isInbox: !due,
        isAllDay: !!t.is_all_day,
        offsets: Array.isArray(t.offsets) ? t.offsets : [],
        assigneeUsername: t.assignee || null,
        nag: normalizeNag(t.nag),
      };
    });

  return tasks.length ? { tasks, question: null } : null;
}

/** Приводим окно долбёжки к разумным рамкам — модель может вернуть что угодно. */
function normalizeNag(nag) {
  if (!nag || !Number.isFinite(Number(nag.every_minutes))) return null;
  const every = Math.max(MIN_NAG_MINUTES, Math.round(Number(nag.every_minutes)));
  const time = (v, fallback) => (/^\d{1,2}:\d{2}$/.test(String(v || '')) ? v : fallback);
  return { everyMinutes: every, from: time(nag.from, '09:00'), to: time(nag.to, '21:00') };
}

// --- Фолбэк без LLM ---------------------------------------------------------

// ВАЖНО: \b в JS считает словом только [A-Za-z0-9_], поэтому вокруг кириллицы
// он не работает. Используем явные lookaround-границы.
const B = '(?<![0-9A-Za-zА-Яа-яЁё_])';
const E = '(?![0-9A-Za-zА-Яа-яЁё_])';

const WEEKDAYS = {
  понедельник: 1, пн: 1,
  вторник: 2, вт: 2,
  среда: 3, среду: 3, ср: 3,
  четверг: 4, чт: 4,
  пятница: 5, пятницу: 5, пт: 5,
  суббота: 6, субботу: 6, сб: 6,
  воскресенье: 7, вс: 7,
};

const MONTHS = {
  января: 1, январь: 1, февраля: 2, февраль: 2, марта: 3, март: 3,
  апреля: 4, апрель: 4, мая: 5, май: 5, июня: 6, июнь: 6,
  июля: 7, июль: 7, августа: 8, август: 8, сентября: 9, сентябрь: 9,
  октября: 10, октябрь: 10, ноября: 11, ноябрь: 11, декабря: 12, декабрь: 12,
};

const DAYPARTS = { утром: 9, утра: 9, днём: 13, днем: 13, вечером: 19, вечера: 19, ночью: 22 };

// «напомни 2 раза» — сколько именно и с какими интервалами.
// Логика: одно предупреждение заранее плюс одно вплотную к сроку.
const BY_COUNT = {
  1: ['30m'],
  2: ['24h', '30m'],
  3: ['24h', '3h', '30m'],
  4: ['24h', '3h', '1h', '15m'],
};

// Длинные варианты первыми, иначе «ср» съест «среду»
const alt = (obj) => Object.keys(obj).sort((a, b) => b.length - a.length).join('|');

export function parseFallback(input, tz = TZ, now = DateTime.now().setZone(tz)) {
  let text = input.trim();

  const eat = (source, flags = 'iu') => {
    const re = new RegExp(source, flags);
    const m = re.exec(text);
    if (!m) return null;
    text = (text.slice(0, m.index) + ' ' + text.slice(m.index + m[0].length)).replace(/\s+/g, ' ');
    return m;
  };

  let m;

  // 1. Исполнитель
  let assigneeUsername = null;
  if ((m = eat('@([a-z0-9_]{4,32})'))) assigneeUsername = m[1];

  // 2. Оговорки про напоминания: «напомни за сутки и за 2 часа»,
  //    «напоминай 2 раза», «напомни в 9:00 и в 19:00», «в день события».
  //
  //    Ключевой момент: разбираем не «всё до точки», а именно оговорку —
  //    цепочку допустимых кусочков подряд. Иначе во фразе
  //    «напомни 2 раза полить цветы завтра в 15:00» сканер принял бы
  //    время самой задачи за время напоминания и съел бы всю фразу.
  const offsets = [];
  const absoluteTimes = [];
  {
    const INTERVAL = `за\\s+(?:\\d+|пару|полчаса)?\\s*(?:полчаса|сутки|суток|день|дня|дней|час[а-яё]*|минут[а-яё]*|недел[а-яё]*)`;
    // «9:10» без предлога — время. «5.08» без предлога — дата, а не 5:08,
    // поэтому точечная форма допускается только после «в».
    const AT_TIME = `(?:\\d{1,2}:\\d{2}|в\\s+\\d{1,2}[:.]\\d{2})`;
    const AT_HOUR = `в\\s+\\d{1,2}(?![:.\\d])(?:\\s*часов)?`;
    const COUNT = `\\d+\\s*раз[а-яё]*`;
    const SAME_DAY = `в\\s+(?:сам[а-яё]*\\s+)?(?:день|дату)\\s+событи[а-яё]*|в\\s+этот\\s+день`;
    // Голый час допускается только как продолжение: «в 9 и 19».
    // Диапазон 0–23, иначе «и 30 минут» приняли бы за время.
    const BARE_HOUR = `(?:[01]?\\d|2[0-3])(?![:.\\d])`;
    const PIECE = `(?:${INTERVAL}|${AT_TIME}|${AT_HOUR}|${COUNT}|${SAME_DAY}|${BARE_HOUR})`;
    const clauseRe = new RegExp(`^(?:\\s*(?:и|,|плюс|а\\s+также)?\\s*${PIECE})+`, 'iu');

    const blockRe = new RegExp(`${B}напом[а-яё]*`, 'giu');
    const cuts = [];
    let block;

    while ((block = blockRe.exec(text))) {
      const after = text.slice(block.index + block[0].length);
      const clauseM = clauseRe.exec(after);
      if (!clauseM) continue;
      const clause = clauseM[0];

      // а) явные интервалы
      const re = new RegExp(
        `за\\s+(\\d+|пару|полчаса)?\\s*(полчаса|сутки|суток|день|дня|дней|час[а-яё]*|минут[а-яё]*|недел[а-яё]*)`,
        'giu'
      );
      let r;
      while ((r = re.exec(clause))) {
        const unit = (r[2] || '').toLowerCase();
        if (!unit) continue;
        const n = /^\d+$/.test(r[1] || '') ? Number(r[1]) : r[1] === 'пару' ? 2 : 1;
        if (unit === 'полчаса') offsets.push('30m');
        else if (unit.startsWith('сут') || unit.startsWith('де') || unit.startsWith('дн')) offsets.push(`${n * 24}h`);
        else if (unit.startsWith('час')) offsets.push(`${n}h`);
        else if (unit.startsWith('минут')) offsets.push(`${n}m`);
        else if (unit.startsWith('недел')) offsets.push(`${n * 7}d`);
      }

      // б) абсолютные времена — переведём в интервалы, когда узнаем срок
      const timeRe = /(\d{1,2}):(\d{2})|в\s+(\d{1,2})[:.](\d{2})/giu;
      let tm;
      while ((tm = timeRe.exec(clause))) {
        const h = Number(tm[1] ?? tm[3]);
        const mi = Number(tm[2] ?? tm[4]);
        if (h <= 23 && mi <= 59) absoluteTimes.push({ h, m: mi });
      }
      // Голые часы ищем только если явных интервалов и количества нет —
      // иначе «за сутки и за 2 часа» дало бы «в 2 часа ночи»
      if (!absoluteTimes.length && !offsets.length && !/раз[а-яё]*/iu.test(clause)) {
        const bareRe = /(?:в\s+)?(\d{1,2})(?![:.\d])/giu;
        let bm;
        while ((bm = bareRe.exec(clause))) {
          const h = Number(bm[1]);
          if (h <= 23) absoluteTimes.push({ h, m: 0 });
        }
      }

      // в) только количество: «напоминай 2 раза»
      if (!offsets.length && !absoluteTimes.length) {
        const cnt = /(\d+)\s*раз[а-яё]*/iu.exec(clause);
        if (cnt && BY_COUNT[Number(cnt[1])]) offsets.push(...BY_COUNT[Number(cnt[1])]);
      }

      cuts.push([block.index, block.index + block[0].length + clause.length]);
    }

    for (const [from, to] of cuts.reverse()) {
      text = (text.slice(0, from) + ' ' + text.slice(to)).replace(/\s+/g, ' ');
    }
  }

  // 3. Дата. Разбираем ДО времени, иначе «12.08» уедет в парсер часов.
  //    dateExplicit — назвал ли пользователь дату явно.
  let dateExplicit = false;
  let date = null;
  let hour = null;
  let minute = 0;

  if ((m = eat(`${B}через\\s+полчаса${E}`))) {
    date = now.plus({ minutes: 30 });
    hour = date.hour;
    minute = date.minute;
  } else if (
    // Число необязательно: «через минуту» = через 1 минуту, «через пару часов» = 2
    (m = eat(`${B}через\\s+(\\d+|пару|несколько)?\\s*(минут[а-яё]*|час[а-яё]*|дн[а-яё]*|день|недел[а-яё]*)${E}`))
  ) {
    const n = /^\d+$/.test(m[1] || '') ? Number(m[1]) : m[1] ? 2 : 1;
    const u = m[2].toLowerCase();
    if (u.startsWith('минут')) date = now.plus({ minutes: n });
    else if (u.startsWith('час')) date = now.plus({ hours: n });
    else if (u.startsWith('недел')) date = now.plus({ weeks: n });
    else date = now.plus({ days: n });
    if (u.startsWith('минут') || u.startsWith('час')) {
      hour = date.hour;
      minute = date.minute;
    }
  } else if (eat(`${B}сегодня${E}`)) date = now;
  else if (eat(`${B}завтра${E}`)) date = now.plus({ days: 1 });
  else if (eat(`${B}послезавтра${E}`)) date = now.plus({ days: 2 });
  else if ((m = eat(`${B}(\\d{1,2})[./](\\d{1,2})(?:[./](\\d{2,4}))?${E}`))) {
    const year = m[3] ? (m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3])) : now.year;
    date = DateTime.fromObject({ year, month: Number(m[2]), day: Number(m[1]) }, { zone: tz });
    if (!m[3] && date < now.startOf('day')) date = date.plus({ years: 1 });
  } else if ((m = eat(`${B}(\\d{1,2})\\s+(${alt(MONTHS)})${E}`))) {
    const month = MONTHS[m[2].toLowerCase()];
    date = DateTime.fromObject({ year: now.year, month, day: Number(m[1]) }, { zone: tz });
    if (date < now.startOf('day')) date = date.plus({ years: 1 });
  } else if ((m = eat(`${B}(?:во?\\s+)?(${alt(WEEKDAYS)})${E}`))) {
    const target = WEEKDAYS[m[1].toLowerCase()];
    let d = now.startOf('day');
    do {
      d = d.plus({ days: 1 });
    } while (d.weekday !== target);
    date = d;
  }

  dateExplicit = date !== null;

  // 4. Время
  if (hour === null) {
    if ((m = eat(`${B}(?:в\\s+)?(\\d{1,2})[:.](\\d{2})${E}`))) {
      hour = Number(m[1]);
      minute = Number(m[2]);
    } else if ((m = eat(`${B}в\\s+(\\d{1,2})(?:\\s*(?:час[а-яё]*))?${E}`))) {
      hour = Number(m[1]);
    } else if ((m = eat(`${B}(${alt(DAYPARTS)})${E}`))) {
      hour = DAYPARTS[m[1].toLowerCase()];
    }
  }

  const isAllDay = hour === null;
  let isAllDayResolved = isAllDay;
  // Ни даты, ни времени — дело без срока, а не «завтра в 9 утра».
  // Но если попросили напомнить «за сутки», дедлайн подразумевается:
  // смещения без срока бессмысленны, поэтому такое остаётся обычной задачей.
  const noSchedule = !date && hour === null && !absoluteTimes.length && !offsets.length;

  if (!date) {
    date = now;
    if (!isAllDay && now.set({ hour, minute, second: 0, millisecond: 0 }) < now) {
      date = now.plus({ days: 1 });
    }
  }

  let dueAt = date.set({
    hour: isAllDay ? ALL_DAY_HOUR : hour,
    minute: isAllDay ? 0 : minute,
    second: 0,
    millisecond: 0,
  });

  // Абсолютные времена напоминаний → интервалы до срока.
  // Если сам срок не назван, берём самое позднее из них как срок задачи:
  // «напомни в 9 и 19» естественнее всего читается как «событие в 19, плюс
  // раннее предупреждение в 9».
  if (absoluteTimes.length) {
    const sorted = [...absoluteTimes].sort((a, b) => a.h * 60 + a.m - (b.h * 60 + b.m));
    if (isAllDay) {
      const last = sorted.pop();
      dueAt = dueAt.set({ hour: last.h, minute: last.m });
      isAllDayResolved = false;
    }
    for (const t of sorted) {
      const at = dueAt.set({ hour: t.h, minute: t.m, second: 0, millisecond: 0 });
      const diffMin = Math.round(dueAt.diff(at, 'minutes').minutes);
      if (diffMin <= 0) continue; // время после срока — пропускаем
      offsets.push(diffMin % 60 === 0 ? `${diffMin / 60}h` : `${diffMin}m`);
    }
  }

  // Опорный час уже прошёл → на завтра. Но только если дату не называли:
  // «5.08 в 9:10», сказанное вечером 5-го, — это просьба на прошедший момент,
  // а не на завтра, и молча переносить её нельзя.
  if (dueAt < now && !dateExplicit) dueAt = dueAt.plus({ days: 1 });

  const title = text
    .replace(/\s+/g, ' ')
    // после вырезания фрагментов остаются «висячие» знаки: «счетчики. , именно»
    .replace(/([.,;:])\s*(?=[.,;:])/g, '')
    .replace(/\s+([.,;:])/g, '$1')
    .replace(new RegExp(`^(?:(?:напом[а-яё]*|поставь|задача|таска|добавь|нужно|надо|именно|мне)${E}\\s*)+`, 'iu'), '')
    .replace(new RegExp(`${B}(?:и|именно)${E}\\s*$`, 'iu'), '')
    .replace(new RegExp(`${B}(?:во?|на|к)${E}\\s*$`, 'iu'), '')
    .replace(/^[\s,.\-–—]+|[\s,.\-–—]+$/g, '')
    .trim();

  return {
    title: title || input.trim(),
    dueAt: noSchedule ? null : dueAt.toJSDate(),
    isInbox: noSchedule,
    isAllDay: isAllDayResolved,
    offsets,
    assigneeUsername,
  };
}
