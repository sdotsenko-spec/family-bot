import 'dotenv/config';
import http from 'node:http';
import { migrate, pool } from './db.js';
import { bot, maybeSendDigest } from './bot.js';
import { dispatchDueReminders } from './reminders.js';
import { syncAllCalendars } from './calendar/ics.js';
import { materializeAll } from './recurrence.js';

const REMINDER_TICK_MS = 60_000;
const CAL_TICK_MS = Number(process.env.CAL_SYNC_MIN || 15) * 60_000;

/**
 * Все фоновые задачи — короткие setInterval-хартбиты, а не длинные setTimeout.
 * Длинный таймер легко теряется при засыпании/рестарте контейнера.
 * Флаг running защищает от наезда прохода на проход.
 */
function heartbeat(name, ms, fn) {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await fn();
    } catch (e) {
      console.error(`[${name}] ошибка:`, e.message);
    } finally {
      running = false;
    }
  };
  setInterval(tick, ms);
  return tick;
}

async function main() {
  await migrate();

  const tickReminders = heartbeat('reminders', REMINDER_TICK_MS, async () => {
    const n = await dispatchDueReminders(bot);
    if (n) console.log(`[reminders] отправлено ${n}`);
  });

  heartbeat('calendars', CAL_TICK_MS, syncAllCalendars);
  heartbeat('recurrences', 3_600_000, materializeAll); // раз в час достраиваем горизонт
  heartbeat('digest', 60_000, maybeSendDigest);

  // Первый проход сразу после старта — добираем всё, что созрело за время деплоя
  setTimeout(tickReminders, 3_000);
  setTimeout(() => syncAllCalendars().catch(() => {}), 10_000);
  setTimeout(() => materializeAll().catch(() => {}), 15_000);

  // Railway любит открытый порт
  const port = process.env.PORT || 3000;
  http
    .createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, ts: new Date().toISOString() }));
    })
    .listen(port, () => console.log(`[http] health на :${port}`));

  bot.start({
    onStart: (me) => console.log(`[bot] запущен как @${me.username}`),
    drop_pending_updates: true,
  });
}

const shutdown = async (signal) => {
  console.log(`[app] ${signal}, останавливаюсь…`);
  try {
    await bot.stop();
  } catch {}
  await pool.end().catch(() => {});
  process.exit(0);
};
process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));

main().catch((e) => {
  console.error('[app] фатальная ошибка:', e);
  process.exit(1);
});
