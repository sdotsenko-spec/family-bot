import 'dotenv/config';
import { migrate, pool } from './db.js';

await migrate();
console.log('Миграции применены');
await pool.end();
