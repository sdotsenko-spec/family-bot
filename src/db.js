import pg from 'pg';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Railway отдаёт DATABASE_URL; ssl нужен только на внешнем хосте
const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL не задан');

// Схема, в которой живут таблицы бота. Дефолт 'family', а не 'public' —
// это позволяет безопасно жить в одной БД с другим приложением: имена
// users/tasks/settings слишком общие, чтобы делить их с кем-то.
// options передаётся в libpq при установке соединения, то есть search_path
// выставлен ДО первого запроса на любом новом клиенте пула.
export const SCHEMA = process.env.DB_SCHEMA || 'family';

if (!/^[a-z_][a-z0-9_]*$/.test(SCHEMA)) {
  throw new Error(`Недопустимое имя схемы: ${SCHEMA}`);
}

export const pool = new pg.Pool({
  connectionString,
  options: `-c search_path=${SCHEMA},public`,
  ssl: /localhost|127\.0\.0\.1|railway\.internal/.test(connectionString)
    ? false
    : { rejectUnauthorized: false },
  max: 5,
});

export const q = (text, params) => pool.query(text, params);

export async function withTx(fn) {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const result = await fn(client);
    await client.query('commit');
    return result;
  } catch (e) {
    await client.query('rollback');
    throw e;
  } finally {
    client.release();
  }
}

export async function migrate() {
  // search_path уже указывает на схему, но саму схему надо создать
  await q(`create schema if not exists ${SCHEMA}`);
  console.log(`[migrate] схема: ${SCHEMA}`);

  await q(`create table if not exists _migrations (
    name text primary key,
    applied_at timestamptz not null default now()
  )`);

  const dir = path.join(__dirname, '..', 'migrations');
  const files = (await fs.readdir(dir)).filter((f) => f.endsWith('.sql')).sort();

  for (const file of files) {
    const { rowCount } = await q('select 1 from _migrations where name = $1', [file]);
    if (rowCount) continue;
    const sql = await fs.readFile(path.join(dir, file), 'utf8');
    await withTx(async (c) => {
      await c.query(sql);
      await c.query('insert into _migrations(name) values ($1)', [file]);
    });
    console.log(`[migrate] применена ${file}`);
  }
}

// --- settings helpers -------------------------------------------------------

export async function getSetting(key, fallback = null) {
  const { rows } = await q('select value from settings where key = $1', [key]);
  return rows.length ? rows[0].value : fallback;
}

export async function setSetting(key, value) {
  await q(
    `insert into settings(key, value) values ($1, $2)
     on conflict (key) do update set value = excluded.value`,
    [key, JSON.stringify(value)]
  );
}

// --- короткоживущий режим ввода --------------------------------------------

const STATE_TTL_MIN = Number(process.env.STATE_TTL_MIN || 10);

export async function setState(userId, mode, targetId = null) {
  await q(
    `insert into user_state (user_id, mode, target_id, expires_at)
     values ($1,$2,$3::int, now() + ($4::text || ' minutes')::interval)
     on conflict (user_id) do update set
       mode = excluded.mode, target_id = excluded.target_id, expires_at = excluded.expires_at`,
    [userId, mode, targetId, String(STATE_TTL_MIN)]
  );
}

export async function getState(userId) {
  const { rows } = await q(
    `select * from user_state where user_id = $1 and expires_at > now()`,
    [userId]
  );
  return rows[0] || null;
}

export async function clearState(userId) {
  await q('delete from user_state where user_id = $1', [userId]);
}
