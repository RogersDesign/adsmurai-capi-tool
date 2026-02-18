'use strict';

require('dotenv').config();

const axios = require('axios');
const iconv = require('iconv-lite');
const { parse } = require('csv-parse/sync');
const crypto = require('crypto');
const pino = require('pino');
const { parse: parseDate, isValid } = require('date-fns');

const log = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: process.env.PINO_PRETTY === '1'
    ? { target: 'pino-pretty', options: { colorize: true } }
    : undefined
});

/**
 * ENV
 */
const CSV_URL = process.env.CSV_URL;
const META_PIXEL_ID = process.env.META_PIXEL_ID;
const META_ACCESS_TOKEN = process.env.META_ACCESS_TOKEN;
const TEST_EVENT_CODE = process.env.TEST_EVENT_CODE || ''; // opcional (Test Events)
const DRY_RUN = (process.env.DRY_RUN || '0') === '1';
const BATCH_SIZE = Number(process.env.BATCH_SIZE || 50);
const META_API_VERSION = process.env.META_API_VERSION || 'v18.0';

if (!CSV_URL) {
  log.error('Falta CSV_URL en .env');
  process.exit(1);
}
if (!META_PIXEL_ID) {
  log.error('Falta META_PIXEL_ID en .env');
  process.exit(1);
}
if (!META_ACCESS_TOKEN) {
  log.error('Falta META_ACCESS_TOKEN en .env');
  process.exit(1);
}

/**
 * Helpers
 */
function driveViewToDirectDownload(url) {
  // Ejemplo:
  // https://drive.google.com/file/d/<FILE_ID>/view?...
  // => https://drive.google.com/uc?export=download&id=<FILE_ID>
  const match = url.match(/\/file\/d\/([^/]+)\/view/);
  if (!match) return url; // si ya viene como directa u otra URL
  const fileId = match[1];
  return `https://drive.google.com/uc?export=download&id=${fileId}`;
}

function sha256(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function normalizeEmail(email) {
  if (!email) return null;
  const v = String(email).trim().toLowerCase();
  if (!v || v === 'null' || v === 'undefined') return null;
  return v;
}

function normalizePhone(phone) {
  if (!phone) return null;
  let v = String(phone).trim();

  // Mantén '+' si existe, pero para hash usaremos solo dígitos (práctica común)
  // Meta recomienda E164; aquí intentamos algo robusto:
  // - quita espacios, guiones, paréntesis
  // - si empieza por 00 => internacional => quitar 00
  // - dejar solo dígitos
  v = v.replace(/\s+/g, '');
  v = v.replace(/[()-]/g, '');

  if (v.startsWith('00')) v = v.slice(2);
  const digitsOnly = v.replace(/\D+/g, '');
  if (!digitsOnly) return null;
  return digitsOnly;
}

function normalizeName(name) {
  if (!name) return { fn: null, ln: null };
  const v = String(name).trim().toLowerCase().replace(/\s+/g, ' ');
  if (!v) return { fn: null, ln: null };
  const parts = v.split(' ');
  const fn = parts[0] || null;
  const ln = parts.length > 1 ? parts.slice(1).join(' ') : null;
  return { fn, ln };
}

function normalizeZip(zip) {
  if (!zip) return null;
  const v = String(zip).trim().toLowerCase().replace(/\s+/g, '');
  return v || null;
}

function normalizeCountry(country) {
  if (!country) return null;
  // Idealmente ISO 3166-1 alpha-2 (ES, FR, etc.)
  const v = String(country).trim().toLowerCase();
  return v || null;
}

function normalizeGender(g) {
  if (!g) return null;
  const v = String(g).trim().toLowerCase();
  if (v === 'm' || v === 'male' || v === 'h' || v === 'hombre') return 'm';
  if (v === 'f' || v === 'female' || v === 'mujer') return 'f';
  return null;
}

function parseCheckoutTimeToUnix(checkoutStr) {
  if (!checkoutStr) return null;

  const raw = String(checkoutStr).trim();

  // dd/mm/yyyy
  const d = parseDate(raw, 'yyyy-MM-dd', new Date());
  if (!isValid(d)) return null;

  // Meta espera segundos UNIX
  return Math.floor(d.getTime() / 1000);
}

function parsePriceAndCurrency(priceStr) {
    if (!priceStr) return { value: null, currency: null };

    const raw = String(priceStr).trim();
    if (!raw) return { value: null, currency: null };

    // Detecta moneda ANTES de limpiar
    let currency = null;
    if (raw.includes('$')) currency = 'USD';
    else if (raw.includes('€')) currency = 'EUR';

    // 1️⃣ Elimina TODO excepto números, coma y punto
    // Esto mata €, $, espacios raros, bytes cp1252, etc.
    let cleaned = raw.replace(/[^\d.,]/g, '');

    // 2️⃣ Normaliza formato europeo:
    // - elimina separadores de miles
    // - convierte coma decimal en punto
    // Ej: "1.234,56" → "1234.56"
    if (cleaned.includes(',') && cleaned.includes('.')) {
        cleaned = cleaned.replace(/\./g, '').replace(',', '.');
    } else {
        cleaned = cleaned.replace(',', '.');
    }

    const value = Number(cleaned);
    if (!Number.isFinite(value)) {
        return { value: null, currency };
    }

    return {
        value,
        currency: currency || 'EUR'
    };
}  

function uniqueNonNull(arr) {
  return [...new Set(arr.filter(Boolean))];
}

function deterministicEventId(row) {
  // Deduplicación estable: mezcla identificadores + fecha + valor
  const emails = uniqueNonNull([
    normalizeEmail(row.email),
    normalizeEmail(row['email.1']),
    normalizeEmail(row['email.2']),
  ]).join('|');

  const phone = normalizePhone(row.phone) || '';
  const checkout = String(row.Checkout_time || '').trim();
  const price = String(row.Price || '').trim();

  return sha256(`${emails}::${phone}::${checkout}::${price}`);
}

/**
 * Build Meta CAPI event from a CSV row
 */
function buildMetaEvent(row) {
  const emailsRaw = [
    normalizeEmail(row.email),
    normalizeEmail(row['email.1']),
    normalizeEmail(row['email.2']),
  ];
  const emails = uniqueNonNull(emailsRaw);
  const emHashed = emails.map(e => sha256(e));

  const phoneNorm = normalizePhone(row.phone);
  const phHashed = phoneNorm ? [sha256(phoneNorm)] : [];

  const { fn, ln } = normalizeName(row.Name);
  const fnHashed = fn ? sha256(fn) : null;
  const lnHashed = ln ? sha256(ln) : null;

  const zipNorm = normalizeZip(row['zip code'] ?? row.zip ?? row.zip_code);
  const zpHashed = zipNorm ? sha256(zipNorm) : null;

  const countryNorm = normalizeCountry(row.country);
  const countryHashed = countryNorm ? sha256(countryNorm) : null;

  const genderNorm = normalizeGender(row.gender);
  const genderHashed = genderNorm ? sha256(genderNorm) : null;

  const eventTime = parseCheckoutTimeToUnix(row.Checkout_time);
  const { value, currency } = parsePriceAndCurrency(row.Price);

  // madid NO se hashea (según tu contexto)
  const madid = row.madid ? String(row.madid).trim() : null;

  const user_data = {};
  if (emHashed.length) user_data.em = emHashed; // array con los 3 emails del mismo user (sin duplicados)
  if (phHashed.length) user_data.ph = phHashed; // array
  if (fnHashed) user_data.fn = fnHashed;
  if (lnHashed) user_data.ln = lnHashed;
  if (zpHashed) user_data.zp = zpHashed;
  if (countryHashed) user_data.country = countryHashed;
  if (genderHashed) user_data.ge = genderHashed;
  if (madid) user_data.madid = madid; // sin hash

  // Meta requiere algunos mínimos; si faltan, igual lo mandamos pero logueamos warning
  const missing = [];
  if (!eventTime) missing.push('Checkout_time->event_time');
  if (value === null) missing.push('Price->value');
  if (!emHashed.length && !phHashed.length && !madid) missing.push('user identifiers (em/ph/madid)');

  const event = {
    event_name: 'Purchase',
    event_time: eventTime || Math.floor(Date.now() / 1000),
    action_source: 'physical_store',
    event_id: deterministicEventId(row),
    user_data,
    custom_data: {
      value: value ?? 0,
      currency: currency || 'EUR'
    }
  };

  if (TEST_EVENT_CODE) {
    event.test_event_code = TEST_EVENT_CODE;
  }

  return { event, missing };
}

/**
 * Download + decode CSV (cp1252)
 */
async function downloadCsv(url) {
  const directUrl = driveViewToDirectDownload(url);
  log.info({ url, directUrl }, 'Descargando CSV...');

  const res = await axios.get(directUrl, {
    responseType: 'arraybuffer',
    // Importante por si Drive redirige:
    maxRedirects: 5,
    validateStatus: s => s >= 200 && s < 400
  });

  // Decode cp1252
  const decoded = iconv.decode(Buffer.from(res.data), 'windows-1252');
  return decoded;
}

function makeUniqueHeaders(headers) {
    const counts = new Map();
    return headers.map((h) => {
      const key = String(h || '').trim();
      const n = counts.get(key) ?? 0;
      counts.set(key, n + 1);
      return n === 0 ? key : `${key}.${n}`; // email, email.1, email.2
    });
  }
  
  function detectDelimiter(firstLine) {
    const commas = (firstLine.match(/,/g) || []).length;
    const semis = (firstLine.match(/;/g) || []).length;
    return semis > commas ? ';' : ',';
  }
  
  function parseCsv(text) {
    const firstLine = text.split(/\r?\n/)[0] || '';
    const delimiter = detectDelimiter(firstLine);
  
    log.info({ delimiter }, 'Delimitador detectado');
  
    const records = parse(text, {
      delimiter,
      columns: (header) => makeUniqueHeaders(header),
      skip_empty_lines: true,
      trim: true,
  
      // Para CSV “imperfectos”
      relax_quotes: true,
      relax_column_count: true,
      quote: '"',
      escape: '"'
    });
  
    return records;
  }  

/**
 * Send batch to Meta CAPI
 */
async function sendBatchToMeta(events) {
  const url = `https://graph.facebook.com/${META_API_VERSION}/${META_PIXEL_ID}/events`;

  if (DRY_RUN) {
    log.warn('DRY_RUN=1 -> Not sending anything to Meta. Showing first event sample...');
    log.info({ sample: events[0] }, 'Evento ejemplo');
    return { dry_run: true, events_sent: events.length };
  }

  const payload = {
    data: events
  };

  const res = await axios.post(url, payload, {
    params: { access_token: META_ACCESS_TOKEN },
    headers: { 'Content-Type': 'application/json' },
    timeout: 30_000,
    validateStatus: s => true // manejamos nosotros
  });

  return { status: res.status, data: res.data };
}

/**
 * Main
 */
async function main() {
  log.info(
    { BATCH_SIZE, DRY_RUN, META_PIXEL_ID, hasTestCode: Boolean(TEST_EVENT_CODE) },
    'Iniciando tool...'
  );

  const csvText = await downloadCsv(CSV_URL);
  const rows = parseCsv(csvText);

  log.info({ rows: rows.length }, 'CSV parseado');

  const metaEvents = [];
  let warnings = 0;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const { event, missing } = buildMetaEvent(row);

    if (missing.length) {
      warnings++;
      log.warn({ rowIndex: i + 1, missing }, 'Fila con campos incompletos (se enviará igualmente)');
    }

    metaEvents.push(event);
  }

  log.info({ warnings, total: metaEvents.length }, 'Eventos construidos');

  // Send in batches
  let sent = 0;
  for (let i = 0; i < metaEvents.length; i += BATCH_SIZE) {
    const batch = metaEvents.slice(i, i + BATCH_SIZE);
    log.info({ batchFrom: i + 1, batchTo: i + batch.length }, 'Enviando batch...');

    const result = await sendBatchToMeta(batch);

    if (result.dry_run) {
      sent += batch.length;
      continue;
    }

    // Meta suele responder 200 con info útil
    // Campos típicos: events_received, messages, fbtrace_id...
    if (result.status === 200) {
      log.info({ metaResponse: result.data }, 'Meta respondió 200 OK');
      sent += batch.length;
    } else {
      log.error({ status: result.status, metaResponse: result.data }, 'Error enviando a Meta');
      process.exitCode = 1;
      // Si quieres que continúe pese a error, comenta este return
      return;
    }
  }

  log.info({ sent }, 'Proceso finalizado');
}

main().catch(err => {
  log.error({ err: err?.message, stack: err?.stack }, 'Fallo inesperado');
  process.exit(1);
});