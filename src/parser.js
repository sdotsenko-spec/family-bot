import { DateTime, TZ, ALL_DAY_HOUR } from './time.js';

/**
 * Разбирает фразу вида «завтра в 18:30 забрать посылку, напомни за день и за 2 часа»
 * в { title, dueAt, isAllDay, offsets, assigneeUsername }.
 *
 * Сначала пробуем Claude (если задан ANTHROPIC_API_KEY) — он вывозит кривые
 * формулировки. Если ключа нет или API упал — работает регексповый фолбэк,
 * его достаточно для 90% бытовых фраз.
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
  return parseFallback(text, tz, now);
}

// --- LLM --------------------------------------------------------------------

const MODEL = process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001';

async function parseWithClaude(text, tz, now) {
  const system = `Ты парсер бытовых задач. Отвечай ТОЛЬКО валидным JSON, без markdown и пояснений.
Схема:
{"title": string, "due_at": string|null, "is_all_day": boolean, "offsets": string[], "assignee": string|null}
- due_at — ISO 8601 со смещением, в таймзоне ${tz}
- если время не указано — is_all_day=true, due_at на ${ALL_DAY_HOUR}:00 нужного дня
- offsets — массив вида ["24h","3h","30m"]; если пользователь не просил — верни []
- assignee — telegram-username без @, если задача явно на кого-то; иначе null
- title — короткий, без даты/времени/слов про напоминания
Сейчас: ${now.toISO()} (${tz}).`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 400,
      system,
      messages: [{ role: 'user', content: text }],
    }),
  });

  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  const raw = (data.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .replace(/```json|```/g, '')
    .trim();

  const parsed = JSON.parse(raw);
  if (!parsed.title) return null;

  const due = parsed.due_at
    ? DateTime.fromISO(parsed.due_at, { zone: tz })
    : now.plus({ days: 1 }).set({ hour: ALL_DAY_HOUR, minute: 0, second: 0, millisecond: 0 });

  return {
    title: parsed.title.trim(),
    dueAt: due.toJSDate(),
    isAllDay: !!parsed.is_all_day,
    offsets: Array.isArray(parsed.offsets) ? parsed.offsets : [],
    assigneeUsername: parsed.assignee || null,
  };
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

  // 2. «напомни за сутки и за 2 часа»
  const offsets = [];
  const remindRe = new RegExp(`${B}напомн[а-яё]*([^.!?]*)`, 'iu');
  const remind = remindRe.exec(text);
  if (remind) {
    const re = new RegExp(
      `за\\s+(\\d+|пару|полчаса)?\\s*(полчаса|сутки|суток|день|дня|дней|час[а-яё]*|минут[а-яё]*|недел[а-яё]*)?`,
      'giu'
    );
    let r;
    let lastEnd = null; // конец последнего распознанного «за …» внутри блока
    while ((r = re.exec(remind[1]))) {
      const unit = (r[2] || r[1] || '').toLowerCase();
      if (!unit) continue;
      const n = /^\d+$/.test(r[1] || '') ? Number(r[1]) : r[1] === 'пару' ? 2 : 1;
      if (unit === 'полчаса') offsets.push('30m');
      else if (unit.startsWith('сут') || unit.startsWith('де') || unit.startsWith('дн')) offsets.push(`${n * 24}h`);
      else if (unit.startsWith('час')) offsets.push(`${n}h`);
      else if (unit.startsWith('минут')) offsets.push(`${n}m`);
      else if (unit.startsWith('недел')) offsets.push(`${n * 7}d`);
      else continue;
      lastEnd = r.index + r[0].length;
    }
    // Вырезаем от «напомни» до конца последнего офсета, а НЕ до конца строки:
    // иначе «напомни за час купить хлеб» потеряет сам текст задачи.
    if (offsets.length) {
      const prefixLen = remind[0].length - remind[1].length;
      const cutTo = remind.index + prefixLen + lastEnd;
      text = (text.slice(0, remind.index) + ' ' + text.slice(cutTo)).replace(/\s+/g, ' ');
    }
  }

  // 3. Дата. Разбираем ДО времени, иначе «12.08» уедет в парсер часов.
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

  // Задача без даты, а опорный час уже прошёл → на завтра, а не в прошлое
  if (dueAt < now) dueAt = dueAt.plus({ days: 1 });

  const title = text
    .replace(/\s+/g, ' ')
    .replace(new RegExp(`^(?:напомн[а-яё]*|поставь|задача|таска|добавь|нужно|надо)${E}\\s*`, 'iu'), '')
    .replace(new RegExp(`${B}(?:во?|на|к)${E}\\s*$`, 'iu'), '')
    .replace(/^[\s,.\-–—]+|[\s,.\-–—]+$/g, '')
    .trim();

  return {
    title: title || input.trim(),
    dueAt: dueAt.toJSDate(),
    isAllDay,
    offsets,
    assigneeUsername,
  };
}
