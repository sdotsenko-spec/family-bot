import ical from 'node-ical';
import { q, withTx } from '../db.js';
import { regenerateReminders, cancelReminders, DEFAULT_OFFSETS } from '../reminders.js';
import { DateTime, TZ, anchorAllDay } from '../time.js';

// На сколько дней вперёд разворачиваем повторяющиеся события
const HORIZON_DAYS = Number(process.env.CAL_HORIZON_DAYS || 60);

// Смещения для импортированных событий — обычно мягче, чем для ручных задач
const CAL_OFFSETS = (process.env.CAL_OFFSETS || '24h,3h').split(',').map((s) => s.trim());

function isAllDay(ev) {
  return ev.datetype === 'date' || ev.start?.dateOnly === true;
}

/** Разворачивает одно VEVENT в конкретные вхождения внутри окна. */
function expand(ev, from, to) {
  const out = [];
  const push = (start, source) => out.push({ start, summary: source.summary, ev: source });

  if (!ev.rrule) {
    if (ev.start >= from && ev.start <= to) push(ev.start, ev);
    return out;
  }

  const excluded = new Set(
    Object.values(ev.exdate || {}).map((d) => new Date(d).toISOString().slice(0, 10))
  );
  const overrides = ev.recurrences || {};

  for (const date of ev.rrule.between(from, to, true)) {
    const key = date.toISOString().slice(0, 10);
    if (excluded.has(key)) continue;
    const override = overrides[key];
    if (override) {
      if (override.status === 'CANCELLED') continue;
      push(override.start, override);
    } else {
      push(date, ev);
    }
  }
  return out;
}

function fingerprint(occ) {
  return `${occ.summary}|${occ.start.toISOString()}|${occ.ev.location || ''}`;
}

export async function syncCalendar(cal) {
  const from = new Date();
  const to = DateTime.now().plus({ days: HORIZON_DAYS }).toJSDate();

  const data = await ical.async.fromURL(cal.url);
  const seen = new Set();
  let created = 0;
  let updated = 0;

  for (const ev of Object.values(data)) {
    if (ev.type !== 'VEVENT') continue;
    if (ev.status === 'CANCELLED') continue;

    for (const occ of expand(ev, from, to)) {
      const allDay = isAllDay(occ.ev);
      const dueAt = allDay ? anchorAllDay(occ.start) : occ.start;
      const externalId = ev.uid;
      const occurrenceStart = new Date(occ.start).toISOString();
      const etag = fingerprint(occ);

      seen.add(`${externalId}|${occurrenceStart}`);

      await withTx(async (c) => {
        // Явный select вместо ON CONFLICT: RETURNING после DO UPDATE отдаёт уже
        // новую строку, и старый etag сравнить не с чем — а нам важно знать,
        // изменилось ли событие на самом деле (иначе пересобираем напоминания
        // при каждом пулле и теряем «уже отправлено»).
        const { rows: existing } = await c.query(
          `select id, etag, status from tasks
            where source='ics' and external_id=$1 and occurrence_start=$2
            for update`,
          [externalId, occurrenceStart]
        );

        if (!existing.length) {
          const { rows } = await c.query(
            `insert into tasks
               (title, notes, due_at, is_all_day, tz, source, calendar_id, external_id,
                occurrence_start, etag, offsets, chat_id, assignee_id)
             values ($1,$2,$3,$4,$5,'ics',$6,$7,$8,$9,$10,$11,$12)
             on conflict do nothing
             returning id`,
            [
              occ.summary || '(без названия)',
              occ.ev.description || null,
              dueAt,
              allDay,
              TZ,
              cal.id,
              externalId,
              occurrenceStart,
              etag,
              JSON.stringify(CAL_OFFSETS),
              process.env.FAMILY_CHAT_ID || null,
              cal.owner_id || null,
            ]
          );
          if (rows.length) {
            created++;
            await regenerateReminders(rows[0].id, c);
          }
          return;
        }

        const row = existing[0];
        if (row.etag === etag) return; // ничего не поменялось

        await c.query(
          `update tasks set title=$2, notes=$3, due_at=$4, is_all_day=$5,
                            etag=$6, updated_at=now()
            where id=$1`,
          [row.id, occ.summary || '(без названия)', occ.ev.description || null, dueAt, allDay, etag]
        );
        updated++;
        if (row.status === 'pending') await regenerateReminders(row.id, c);
      });
    }
  }

  // События, исчезнувшие из фида (удалены в календаре) — гасим
  const { rows: stale } = await q(
    `select id, external_id, occurrence_start from tasks
      where calendar_id = $1 and status = 'pending' and due_at between $2 and $3`,
    [cal.id, from, to]
  );
  let cancelled = 0;
  for (const t of stale) {
    const key = `${t.external_id}|${new Date(t.occurrence_start).toISOString()}`;
    if (seen.has(key)) continue;
    await q(`update tasks set status='cancelled', updated_at=now() where id=$1`, [t.id]);
    await cancelReminders(t.id);
    cancelled++;
  }

  await q(`update calendars set last_sync_at=now(), last_error=null where id=$1`, [cal.id]);
  return { created, updated, cancelled };
}

export async function syncAllCalendars() {
  const { rows } = await q('select * from calendars where active = true');
  const totals = { created: 0, updated: 0, cancelled: 0 };

  for (const cal of rows) {
    try {
      const r = await syncCalendar(cal);
      totals.created += r.created;
      totals.updated += r.updated;
      totals.cancelled += r.cancelled;
      console.log(`[cal] ${cal.label || cal.id}: +${r.created} ~${r.updated} -${r.cancelled}`);
    } catch (e) {
      console.error(`[cal] ${cal.label || cal.id} упал:`, e.message);
      await q(`update calendars set last_error=$2, last_sync_at=now() where id=$1`, [
        cal.id,
        e.message.slice(0, 500),
      ]);
    }
  }
  return totals;
}

export { DEFAULT_OFFSETS };
