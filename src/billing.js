import { q } from './db.js';
import { DateTime, TZ } from './time.js';
import { displayName } from './meters.js';

const esc = (s) =>
  String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const money = (n) =>
  Number(n)
    .toFixed(2)
    .replace(/\.00$/, '')
    .replace('.', ',');

const qty = (n) =>
  Number(n)
    .toFixed(3)
    .replace(/\.?0+$/, '')
    .replace('.', ',');

/**
 * Актуальные позиции на дату: для каждой пары (поставщик, название)
 * берём строку с самой свежей valid_from, не позже указанной даты.
 * Так старые периоды считаются старыми тарифами, а не текущими.
 */
export async function chargesAt(onDate) {
  const { rows } = await q(
    `select distinct on (provider, name) c.*, m.name as meter_name, m.group_name, m.unit
       from charges c
       left join meters m on m.id = c.meter_id
      where c.active = true and c.valid_from <= $1::date
      order by provider, name, valid_from desc`,
    [onDate]
  );
  return rows.sort((a, b) => a.position - b.position || a.id - b.id);
}

/** Последние два показания счётчика — расход и границы периода. */
async function lastDelta(meterId) {
  const { rows } = await q(
    `select value, taken_at from meter_readings
      where meter_id = $1 order by taken_at desc, id desc limit 2`,
    [meterId]
  );
  if (rows.length < 2) return null;
  return {
    delta: Number(rows[0].value) - Number(rows[1].value),
    from: rows[1].taken_at,
    to: rows[0].taken_at,
  };
}

/**
 * Считает счёт по последней паре показаний каждого счётчика.
 * Период берём как есть — «от снятия до снятия», а не календарный месяц:
 * именно так показания и снимаются, и так цифры сходятся с платёжкой.
 */
export async function computeBill() {
  const meterDeltas = new Map();
  let periodStart = null;
  let periodEnd = null;

  const { rows: meters } = await q('select id from meters where active = true');
  for (const m of meters) {
    const d = await lastDelta(m.id);
    if (!d) continue;
    meterDeltas.set(m.id, d);
    if (!periodStart || d.from < periodStart) periodStart = d.from;
    if (!periodEnd || d.to > periodEnd) periodEnd = d.to;
  }

  const onDate = (periodEnd ? DateTime.fromJSDate(periodEnd) : DateTime.now()).toISODate();
  const charges = await chargesAt(onDate);
  if (!charges.length) return { empty: true };

  const providers = new Map();
  let total = 0;
  const missing = [];

  for (const c of charges) {
    if (!providers.has(c.provider)) providers.set(c.provider, { lines: [], sum: 0 });
    const group = providers.get(c.provider);

    if (c.kind === 'fixed') {
      const amount = Number(c.rate);
      group.lines.push({ name: c.name, amount });
      group.sum += amount;
      total += amount;
      continue;
    }

    const d = c.meter_id ? meterDeltas.get(c.meter_id) : null;
    if (!d) {
      missing.push(c.name);
      continue;
    }
    const amount = d.delta * Number(c.rate);
    group.lines.push({
      name: c.name,
      amount,
      volume: d.delta,
      rate: Number(c.rate),
      unit: c.unit || '',
    });
    group.sum += amount;
    total += amount;
  }

  return {
    periodStart,
    periodEnd,
    total,
    providers: [...providers.entries()].map(([provider, g]) => ({ provider, ...g })),
    missing,
  };
}

export async function saveBill(bill) {
  if (bill.empty || !bill.periodEnd) return null;
  const { rows } = await q(
    `insert into bills (period_start, period_end, total, breakdown)
     values ($1,$2,$3,$4) returning *`,
    [bill.periodStart, bill.periodEnd, bill.total.toFixed(2), JSON.stringify(bill.providers)]
  );
  return rows[0];
}

/** Предыдущий сохранённый счёт — для сравнения «стало / было». */
async function previousBill(beforeDate) {
  const { rows } = await q(
    `select * from bills where period_end < $1 order by period_end desc limit 1`,
    [beforeDate]
  );
  return rows[0] || null;
}

export async function renderBill(bill) {
  if (bill.empty) {
    return (
      'Начисления не заведены.\n\n' +
      'Заполнить по вашим платёжкам одной командой: <code>/bill setup</code>'
    );
  }
  if (!bill.periodEnd) {
    return 'Нужны показания минимум за два раза — иначе расход считать не с чем.';
  }

  const from = DateTime.fromJSDate(bill.periodStart).setZone(TZ).toFormat('dd.MM');
  const to = DateTime.fromJSDate(bill.periodEnd).setZone(TZ).toFormat('dd.MM');
  const lines = [`🧾 <b>Коммуналка за ${from} — ${to}</b>`, ''];

  for (const group of bill.providers) {
    lines.push(`<b>${esc(group.provider)}</b> — ${money(group.sum)} грн`);
    for (const l of group.lines) {
      lines.push(
        l.volume === undefined
          ? `   ${esc(l.name)}: ${money(l.amount)}`
          : `   ${esc(l.name)}: ${qty(l.volume)}${l.unit ? ' ' + esc(l.unit) : ''} × ${money(l.rate)} = ${money(l.amount)}`
      );
    }
    lines.push('');
  }

  lines.push(`<b>Итого: ${money(bill.total)} грн</b>`);

  const prev = await previousBill(bill.periodEnd);
  if (prev) {
    const diff = bill.total - Number(prev.total);
    const when = DateTime.fromJSDate(prev.period_end).setZone(TZ).toFormat('dd.MM');
    lines.push(
      `<i>Прошлый период (до ${when}): ${money(prev.total)} — ` +
        `${diff >= 0 ? '+' : '−'}${money(Math.abs(diff))}</i>`
    );
  }

  if (bill.missing.length) {
    lines.push('', `⚠️ <i>Нет показаний: ${bill.missing.map(esc).join(', ')}</i>`);
  }

  return lines.join('\n');
}

export async function listCharges() {
  const rows = await chargesAt(DateTime.now().toISODate());
  if (!rows.length) return 'Начисления не заведены. <code>/bill setup</code>';

  const byProvider = new Map();
  for (const c of rows) {
    if (!byProvider.has(c.provider)) byProvider.set(c.provider, []);
    byProvider.get(c.provider).push(c);
  }

  const out = ['<b>Начисления</b>', ''];
  for (const [provider, items] of byProvider) {
    out.push(`<b>${esc(provider)}</b>`);
    for (const c of items) {
      const target = c.meter_id
        ? ` × ${esc(displayName({ name: c.meter_name, group_name: c.group_name }))}`
        : ' (фикс.)';
      out.push(`   ${esc(c.name)}: ${money(c.rate)}${target}  <code>#C${c.id}</code>`);
    }
    out.push('');
  }
  out.push('<i>Изменить цену: /tariff #C3 31.5 — старая останется в истории</i>');
  return out.join('\n');
}

export async function addCharge({ provider, name, kind, meterId, rate, validFrom, position }) {
  const { rows } = await q(
    `insert into charges (provider, name, kind, meter_id, rate, valid_from, position)
     values ($1,$2,$3,$4::int,$5,$6::date,$7) returning *`,
    [provider, name, kind, meterId || null, rate, validFrom || DateTime.now().toISODate(), position || 0]
  );
  return rows[0];
}

/**
 * Новая цена — это новая строка с новой датой, а не правка старой.
 * Иначе прошлые периоды пересчитались бы задним числом.
 */
export async function updateRate(chargeId, rate, validFrom) {
  const { rows } = await q('select * from charges where id = $1', [chargeId]);
  if (!rows.length) return null;
  const c = rows[0];
  return addCharge({
    provider: c.provider,
    name: c.name,
    kind: c.kind,
    meterId: c.meter_id,
    rate,
    validFrom: validFrom || DateTime.now().toISODate(),
    position: c.position,
  });
}

export async function deactivateCharge(id) {
  const { rows } = await q(
    `update charges set active = false
      where provider = (select provider from charges where id = $1)
        and name = (select name from charges where id = $1)
      returning name`,
    [id]
  );
  return rows[0] || null;
}

/**
 * Заполнение по платёжкам за апрель–июль 2026, Ю. Кондратюка 7.
 * Абонплаты в июне менялись, поэтому заводятся двумя строками с датами.
 */
export const SETUP = [
  { provider: 'Квартплата', name: 'Утримання буд.', kind: 'fixed', rate: 1468.66 },
  { provider: 'Квартплата', name: 'Охорона', kind: 'fixed', rate: 480 },
  { provider: 'Квартплата', name: 'Відеоспостереження', kind: 'fixed', rate: 36 },

  { provider: 'Киевводоканал', name: 'Постачання ХВ', kind: 'metered', meter: 'вода холодная', rate: 30.384 },
  { provider: 'Киевводоканал', name: 'Абонентське обсл.', kind: 'fixed', rate: 47.52 },
  { provider: 'Киевводоканал', name: 'Водовідведення ГВ', kind: 'metered', meter: 'вода горячая', rate: 14.22 },

  { provider: 'Гаряча вода', name: 'Постачання ГВ', kind: 'metered', meter: 'вода горячая', rate: 97.89 },
  { provider: 'Гаряча вода', name: 'Абонентське обсл.', kind: 'fixed', rate: 29.3, validFrom: '2026-04-01' },
  { provider: 'Гаряча вода', name: 'Абонентське обсл.', kind: 'fixed', rate: 30.6, validFrom: '2026-06-01' },

  { provider: 'Теплова енергія', name: 'ТЕ (ЦО) з ФСГ', kind: 'metered', meter: 'отопление', rate: 1654.41 },
  { provider: 'Теплова енергія', name: 'Абонентське обсл.', kind: 'fixed', rate: 42.44, validFrom: '2026-04-01' },
  { provider: 'Теплова енергія', name: 'Абонентське обсл.', kind: 'fixed', rate: 43.39, validFrom: '2026-06-01' },

  { provider: 'Електроенергія', name: 'День', kind: 'metered', meter: 'день', rate: 4.32 },
  { provider: 'Електроенергія', name: 'Ніч', kind: 'metered', meter: 'ночь', rate: 2.16 },
];

export async function setupFromInvoices() {
  const { rows: meters } = await q('select * from meters where active = true');
  const findMeter = (hint) =>
    meters.find((m) => displayName(m).toLowerCase().includes(hint)) || null;

  const created = [];
  const skipped = [];
  let position = 0;

  for (const item of SETUP) {
    position += 1;
    const meter = item.meter ? findMeter(item.meter) : null;
    if (item.kind === 'metered' && !meter) {
      skipped.push(`${item.name} (нет счётчика «${item.meter}»)`);
      continue;
    }
    const { rowCount } = await q(
      `select 1 from charges where provider=$1 and name=$2 and valid_from=$3::date`,
      [item.provider, item.name, item.validFrom || '2026-04-01']
    );
    if (rowCount) continue;

    await addCharge({
      provider: item.provider,
      name: item.name,
      kind: item.kind,
      meterId: meter?.id,
      rate: item.rate,
      validFrom: item.validFrom || '2026-04-01',
      position,
    });
    created.push(item.name);
  }

  return { created, skipped };
}
