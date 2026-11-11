import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildLeadMessage, createApp, getReadiness, loadConfig, validateLead } from './server.mjs';

const validLead = {
  companyName: '',
  inn: '',
  contactName: 'Иван Петров',
  phone: '+7 900 000-00-00',
  email: 'ivan@example.ru',
  amount: '1 тонна',
  task: 'Нужна грунтовка для металлоконструкций',
  consent: true,
  source: 'https://irekgai111-lang.github.io/irke/anmarso/'
};

test('принимает заявку без компании и ИНН', () => {
  assert.equal(validateLead(validLead).ok, true);
});

test('принимает корректный ИНН, когда он указан', () => {
  assert.equal(validateLead({ ...validLead, companyName: 'ООО Тест', inn: '1651097700' }).ok, true);
});

test('отклоняет ошибочный ИНН', () => {
  const result = validateLead({ ...validLead, inn: '12345' });
  assert.equal(result.ok, false);
  assert.match(result.errors.join(' '), /ИНН/);
});

test('отклоняет ловушку для ботов', () => {
  assert.equal(validateLead({ ...validLead, website: 'spam.example' }).ok, false);
});

test('проверяет телефон, описание и согласие', () => {
  assert.equal(validateLead({ ...validLead, phone: '12' }).ok, false);
  assert.equal(validateLead({ ...validLead, task: 'нет' }).ok, false);
  assert.equal(validateLead({ ...validLead, consent: false }).ok, false);
});

test('очищает управляющие символы и ограничивает длину', () => {
  const result = validateLead({ ...validLead, contactName: `Иван\u0000${'А'.repeat(300)}` });
  assert.equal(result.ok, true);
  assert.equal(result.lead.contactName.includes('\u0000'), false);
  assert.equal(result.lead.contactName.length, 160);
});

test('формирует понятное уведомление', () => {
  const message = buildLeadMessage('20261111-ABC12345', validLead, new Date('2026-11-11T10:00:00Z'));
  assert.match(message, /НОВАЯ ЗАЯВКА АНМАРСО № 20261111-ABC12345/);
  assert.match(message, /Организация: не указана/);
  assert.match(message, /Телефон: \+7 900 000-00-00/);
});

test('не объявляет публичную готовность без почты', () => {
  const result = getReadiness(loadConfig({ DRY_RUN: 'false' }));
  assert.equal(result.ready, false);
  assert.equal(result.acceptingLeads, true);
  assert.deepEqual(result.missing, ['почтовое уведомление']);
});

test('объявляет готовность при рабочем режиме и настроенной почте', () => {
  const result = getReadiness(loadConfig({
    DRY_RUN: 'false',
    MAIL_USER: 'site@example.ru',
    MAIL_APP_PASSWORD: 'secret',
    MAIL_TO: 'manager@example.ru'
  }));
  assert.equal(result.ready, true);
  assert.equal(result.notifications.email, true);
});

async function start(config, dependencies) {
  const server = createApp(config, dependencies);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return server;
}

test('health работает, а чужой сайт блокируется', async t => {
  const config = loadConfig({ PORT: '0', DRY_RUN: 'true', ALLOWED_ORIGINS: 'https://allowed.example' });
  const server = await start(config);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(`${base}/health`)).status, 200);
  assert.equal((await fetch(`${base}/ready`)).status, 503);
  assert.equal((await fetch(`${base}/health`, { headers: { Origin: 'https://evil.example' } })).status, 403);
});

test('в пробном режиме заявки не принимаются', async t => {
  const config = loadConfig({ PORT: '0', DRY_RUN: 'true', ALLOWED_ORIGINS: 'https://allowed.example' });
  const server = await start(config);
  t.after(() => server.close());
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/leads`, {
    method: 'POST',
    headers: { Origin: 'https://allowed.example', 'Content-Type': 'application/json' },
    body: JSON.stringify(validLead)
  });
  assert.equal(response.status, 503);
});

test('сохраняет заявку до отправки уведомления', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'anmarso-api-'));
  const config = loadConfig({
    PORT: '0',
    DRY_RUN: 'false',
    REQUIRE_EMAIL: 'true',
    ALLOWED_ORIGINS: 'https://allowed.example',
    DATA_DIR: dataDir,
    MAIL_USER: 'site@example.ru',
    MAIL_APP_PASSWORD: 'secret',
    MAIL_TO: 'manager@example.ru'
  });
  const mailer = async () => ({ channel: 'email', status: 'sent' });
  const server = await start(config, { mailer });
  t.after(async () => { server.close(); await rm(dataDir, { recursive: true, force: true }); });
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/leads`, {
    method: 'POST',
    headers: { Origin: 'https://allowed.example', 'Content-Type': 'application/json' },
    body: JSON.stringify(validLead)
  });
  assert.equal(response.status, 201);
  const payload = await response.json();
  assert.match(payload.id, /^\d{8}-[A-F0-9]{8}$/);
  assert.equal(payload.notification.email, 'sent');
  const records = (await readFile(join(dataDir, 'leads.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(records.length, 2);
  assert.equal(records[0].id, payload.id);
  assert.equal(records[0].lead.phone, validLead.phone);
  assert.equal(records[1].notification.status, 'sent');
});

test('сообщает о сохранении, если почтовое уведомление не прошло', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'anmarso-api-'));
  const config = loadConfig({
    PORT: '0', DRY_RUN: 'false', REQUIRE_EMAIL: 'true',
    ALLOWED_ORIGINS: 'https://allowed.example', DATA_DIR: dataDir,
    MAIL_USER: 'site@example.ru', MAIL_APP_PASSWORD: 'secret', MAIL_TO: 'manager@example.ru'
  });
  const mailer = async () => { throw new Error('Временная ошибка'); };
  const server = await start(config, { mailer });
  t.after(async () => { server.close(); await rm(dataDir, { recursive: true, force: true }); });
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/leads`, {
    method: 'POST',
    headers: { Origin: 'https://allowed.example', 'Content-Type': 'application/json' },
    body: JSON.stringify(validLead)
  });
  assert.equal(response.status, 503);
  const payload = await response.json();
  assert.equal(payload.saved, true);
  assert.match(payload.id, /^\d{8}-[A-F0-9]{8}$/);
});
