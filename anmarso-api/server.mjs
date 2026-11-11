import http from 'node:http';
import tls from 'node:tls';
import { appendFile, mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff'
};

export function loadConfig(env = process.env) {
  return {
    port: Number(env.PORT || 8787),
    dataDir: env.DATA_DIR || './data',
    dryRun: env.DRY_RUN !== 'false',
    requireEmail: env.REQUIRE_EMAIL !== 'false',
    allowedOrigins: new Set(
      (env.ALLOWED_ORIGINS || 'https://irekgai111-lang.github.io')
        .split(',').map(value => value.trim()).filter(Boolean)
    ),
    mail: {
      host: env.MAIL_HOST || 'smtp.mail.ru',
      port: Number(env.MAIL_PORT || 465),
      user: env.MAIL_USER || '',
      password: env.MAIL_APP_PASSWORD || '',
      to: env.MAIL_TO || 'Anmarsoms@mail.ru'
    }
  };
}

function emailConfigured(config) {
  return Boolean(config.mail.host && config.mail.port && config.mail.user && config.mail.password && config.mail.to);
}

export function getReadiness(config) {
  const email = emailConfigured(config);
  const missing = [];
  if (config.dryRun) missing.push('рабочий режим');
  if (config.requireEmail && !email) missing.push('почтовое уведомление');
  return {
    ready: missing.length === 0,
    acceptingLeads: !config.dryRun,
    storage: 'local',
    notifications: { email },
    missing
  };
}

function clean(value, max = 500) {
  return String(value ?? '')
    .trim()
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .slice(0, max);
}

function digits(value) {
  return String(value ?? '').replace(/\D/g, '');
}

function validPhone(value) {
  const phone = digits(value);
  return phone.length >= 10 && phone.length <= 15;
}

function validEmail(value) {
  return !value || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function validInn(value) {
  const inn = digits(value);
  return !inn || inn.length === 10 || inn.length === 12;
}

export function validateLead(input = {}) {
  const lead = {
    companyName: clean(input.companyName, 240),
    inn: digits(input.inn),
    contactName: clean(input.contactName, 160),
    phone: clean(input.phone, 40),
    email: clean(input.email, 180),
    amount: clean(input.amount, 120),
    deadline: clean(input.deadline, 120),
    delivery: clean(input.delivery, 180),
    task: clean(input.task, 2000),
    consent: input.consent === true,
    source: clean(input.source, 200) || 'Сайт АНМАРСО',
    website: clean(input.website, 200)
  };

  const errors = [];
  if (lead.website) errors.push('Обнаружено автоматическое заполнение');
  if (lead.companyName && lead.companyName.length < 2) errors.push('Проверьте название организации');
  if (!validInn(lead.inn)) errors.push('Проверьте ИНН');
  if (lead.contactName.length < 2) errors.push('Укажите имя');
  if (!validPhone(lead.phone)) errors.push('Укажите корректный телефон');
  if (!validEmail(lead.email)) errors.push('Укажите корректную электронную почту');
  if (lead.task.length < 5) errors.push('Опишите задачу');
  if (!lead.consent) errors.push('Подтвердите согласие на обработку данных');
  return { ok: errors.length === 0, errors, lead };
}

export function buildLeadMessage(id, lead, createdAt = new Date()) {
  return [
    `НОВАЯ ЗАЯВКА АНМАРСО № ${id}`,
    '',
    lead.companyName ? `Организация: ${lead.companyName}` : 'Организация: не указана',
    lead.inn ? `ИНН: ${lead.inn}` : '',
    `Имя: ${lead.contactName}`,
    `Телефон: ${lead.phone}`,
    lead.email ? `Электронная почта: ${lead.email}` : '',
    lead.amount ? `Объём: ${lead.amount}` : '',
    lead.deadline ? `Желаемый срок: ${lead.deadline}` : '',
    lead.delivery ? `Получение заказа: ${lead.delivery}` : '',
    '',
    `Задача: ${lead.task}`,
    '',
    `Источник: ${lead.source}`,
    `Дата: ${createdAt.toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' })} МСК`
  ].filter(Boolean).join('\n');
}

async function readJson(req, limit = 64 * 1024) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > limit) throw Object.assign(new Error('Слишком большой запрос'), { status: 413 });
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    throw Object.assign(new Error('Некорректный запрос'), { status: 400 });
  }
}

async function saveRecord(config, record) {
  await mkdir(config.dataDir, { recursive: true, mode: 0o700 });
  await appendFile(
    `${config.dataDir}/leads.jsonl`,
    `${JSON.stringify(record)}\n`,
    { encoding: 'utf8', mode: 0o600 }
  );
}

function waitForSmtp(socket) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const onData = data => {
      buffer += data.toString('utf8');
      const lines = buffer.split(/\r?\n/).filter(Boolean);
      const last = lines.at(-1) || '';
      if (/^\d{3} /.test(last)) {
        cleanup();
        resolve({ code: Number(last.slice(0, 3)), text: lines.join('\n') });
      }
    };
    const onError = error => { cleanup(); reject(error); };
    const cleanup = () => {
      socket.off('data', onData);
      socket.off('error', onError);
    };
    socket.on('data', onData);
    socket.on('error', onError);
  });
}

async function smtpCommand(socket, command, expected) {
  const response = waitForSmtp(socket);
  if (command !== null) socket.write(`${command}\r\n`);
  const result = await response;
  if (!expected.includes(result.code)) throw new Error(`SMTP ${result.code}`);
  return result;
}

function encodedHeader(value) {
  return `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

function base64Lines(value) {
  return Buffer.from(value, 'utf8').toString('base64').match(/.{1,76}/g).join('\r\n');
}

export async function sendMail(config, subject, body) {
  if (!emailConfigured(config)) return { channel: 'email', status: 'not_configured' };
  const socket = tls.connect({
    host: config.mail.host,
    port: config.mail.port,
    servername: config.mail.host,
    rejectUnauthorized: true
  });
  socket.setTimeout(12_000, () => socket.destroy(new Error('SMTP timeout')));
  await new Promise((resolve, reject) => {
    socket.once('secureConnect', resolve);
    socket.once('error', reject);
  });
  try {
    await smtpCommand(socket, null, [220]);
    await smtpCommand(socket, 'EHLO anmarso-site', [250]);
    await smtpCommand(socket, 'AUTH LOGIN', [334]);
    await smtpCommand(socket, Buffer.from(config.mail.user).toString('base64'), [334]);
    await smtpCommand(socket, Buffer.from(config.mail.password).toString('base64'), [235]);
    await smtpCommand(socket, `MAIL FROM:<${config.mail.user}>`, [250]);
    await smtpCommand(socket, `RCPT TO:<${config.mail.to}>`, [250, 251]);
    await smtpCommand(socket, 'DATA', [354]);
    const message = [
      `From: ${encodedHeader('Сайт АНМАРСО')} <${config.mail.user}>`,
      `To: <${config.mail.to}>`,
      `Subject: ${encodedHeader(subject)}`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
      '',
      base64Lines(body),
      '.'
    ].join('\r\n');
    await smtpCommand(socket, message, [250]);
    await smtpCommand(socket, 'QUIT', [221]);
    return { channel: 'email', status: 'sent' };
  } finally {
    socket.destroy();
  }
}

class RateLimiter {
  constructor() { this.entries = new Map(); }
  allow(key, max, windowMs) {
    const now = Date.now();
    const current = this.entries.get(key);
    if (!current || current.resetAt <= now) {
      this.entries.set(key, { count: 1, resetAt: now + windowMs });
      return true;
    }
    if (current.count >= max) return false;
    current.count += 1;
    return true;
  }
}

function sendJson(res, status, payload, origin, config) {
  const headers = { ...JSON_HEADERS };
  if (origin && config.allowedOrigins.has(origin)) {
    headers['Access-Control-Allow-Origin'] = origin;
    headers.Vary = 'Origin';
  }
  res.writeHead(status, headers);
  res.end(JSON.stringify(payload));
}

export function createApp(config = loadConfig(), { mailer = sendMail } = {}) {
  const limiter = new RateLimiter();
  const server = http.createServer(async (req, res) => {
    const origin = String(req.headers.origin || '');
    const remote = req.socket.remoteAddress || 'unknown';
    const forwarded = clean(req.headers['x-forwarded-for'], 120).split(',')[0].trim();
    const ip = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote) && forwarded ? forwarded : remote;

    try {
      if (origin && !config.allowedOrigins.has(origin)) {
        return sendJson(res, 403, { error: 'Источник запроса не разрешён' }, '', config);
      }
      if (req.method === 'OPTIONS') {
        if (!origin) return sendJson(res, 400, { error: 'Не указан источник' }, '', config);
        res.writeHead(204, {
          'Access-Control-Allow-Origin': origin,
          'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
          'Access-Control-Max-Age': '600',
          Vary: 'Origin'
        });
        return res.end();
      }
      if (req.method === 'GET' && req.url === '/health') {
        return sendJson(res, 200, { ok: true, service: 'anmarso-leads-v2' }, origin, config);
      }
      if (req.method === 'GET' && req.url === '/ready') {
        const readiness = getReadiness(config);
        return sendJson(res, readiness.ready ? 200 : 503, readiness, origin, config);
      }
      if (req.method === 'POST' && req.url === '/api/leads') {
        if (!String(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) {
          return sendJson(res, 415, { error: 'Требуется JSON' }, origin, config);
        }
        if (!limiter.allow(`lead:${ip}`, 5, 60 * 60_000)) {
          return sendJson(res, 429, { error: 'Слишком много заявок. Попробуйте позже' }, origin, config);
        }
        if (config.dryRun) {
          return sendJson(res, 503, { error: 'Приём заявок ещё не включён' }, origin, config);
        }
        const validation = validateLead(await readJson(req));
        if (!validation.ok) {
          return sendJson(res, 422, { error: 'Проверьте поля', details: validation.errors }, origin, config);
        }

        const id = `${new Date().toISOString().slice(0, 10).replaceAll('-', '')}-${randomUUID().slice(0, 8).toUpperCase()}`;
        const createdAt = new Date();
        const record = { id, createdAt: createdAt.toISOString(), lead: validation.lead, notification: { email: 'pending' } };
        await saveRecord(config, record);

        let email = { channel: 'email', status: 'not_configured' };
        try {
          email = await mailer(config, `Заявка АНМАРСО № ${id}`, buildLeadMessage(id, validation.lead, createdAt));
        } catch (error) {
          email = { channel: 'email', status: 'failed', error: clean(error.message, 180) };
        }
        await saveRecord(config, { id, notificationAt: new Date().toISOString(), notification: email });

        if (config.requireEmail && email.status !== 'sent') {
          return sendJson(res, 503, {
            error: 'Заявка сохранена, но уведомление временно не отправлено',
            id,
            saved: true
          }, origin, config);
        }
        return sendJson(res, 201, { ok: true, id, saved: true, notification: { email: email.status } }, origin, config);
      }
      return sendJson(res, 404, { error: 'Не найдено' }, origin, config);
    } catch (error) {
      console.error(new Date().toISOString(), clean(error.stack || error.message, 2000));
      const status = Number(error.status) || 500;
      return sendJson(
        res,
        status,
        { error: status < 500 ? error.message : 'Временная ошибка сервера' },
        origin,
        config
      );
    }
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const config = loadConfig();
  const server = createApp(config);
  server.listen(config.port, '127.0.0.1', () => {
    console.log(`anmarso-leads-v2 listening on 127.0.0.1:${config.port}; dryRun=${config.dryRun}`);
  });
}
