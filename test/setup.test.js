import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startSetup } from '../src/setup.js';

function request(url, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method, headers, agent: false }, res => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

async function fixture(t, options = {}) {
  const calls = [];
  const setup = await startSetup({
    verify: async (account, password) => { calls.push({ operation: 'verify', account: structuredClone(account), password }); return { sent: 'Wysłane', drafts: 'Szkice' }; },
    saveAccount: async (account, password) => { calls.push({ operation: 'save', account: structuredClone(account), password }); },
    listAccounts: async () => [], ...options,
  });
  t.after(() => setup.close());
  const get = await request(setup.url);
  const token = get.text.match(/name="token" value="([^"]+)"/)?.[1];
  const submit = (changes = {}, requestOptions = {}) => request(setup.url, {
    method: 'POST',
    headers: { origin: new URL(setup.url).origin, 'content-type': 'application/x-www-form-urlencoded', ...(requestOptions.headers || {}) },
    body: new URLSearchParams({ token, email: 'person@example.pl', password: 'private-mailbox-password', imapHost: 'serwer123456.home.pl', ...changes }).toString(),
    ...Object.fromEntries(Object.entries(requestOptions).filter(([key]) => key !== 'headers')),
  });
  return { setup, calls, get, token, submit };
}

test('local browser flow verifies both protocols before saving, detects folders and closes after success', async t => {
  const { setup, calls, get, submit } = await fixture(t);
  assert.equal(new URL(setup.url).hostname, '127.0.0.1');
  assert.equal(get.status, 200);
  assert.match(get.headers['content-security-policy'], /default-src 'none'/);
  assert.match(get.headers['content-security-policy'], /frame-ancestors 'none'/);
  assert.equal(get.headers['cache-control'], 'no-store');
  assert.equal(get.headers['referrer-policy'], 'no-referrer');
  assert.equal(get.headers['access-control-allow-origin'], undefined);
  const result = await submit({ trash: 'Kosz' });
  assert.equal(result.status, 200);
  assert.match(result.text, /Email connected/);
  assert.doesNotMatch(result.text, /private-mailbox-password/);
  assert.deepEqual(calls.map(c => c.operation), ['verify', 'save']);
  assert.equal(calls[1].password, 'private-mailbox-password');
  assert.deepEqual(calls[1].account.folders, { sent: 'Wysłane', drafts: 'Szkice', trash: 'Kosz' });
  assert.equal(calls[1].account.imap.port, 993);
  assert.equal(calls[1].account.smtp.port, 465);
  const completion = await setup.completion;
  assert.equal(completion.status, 'connected');
  assert.equal(completion.account.email, 'person@example.pl');
  assert.doesNotMatch(JSON.stringify(completion), /private-mailbox-password/);
  await assert.rejects(request(setup.url));
});

test('setup rejects cross-origin posts, missing origin/token, guessed routes, and DNS-rebinding Host', async t => {
  const { setup, calls, submit } = await fixture(t);
  assert.equal((await submit({}, { headers: { origin: 'https://attacker.example' } })).status, 403);
  assert.equal((await submit({}, { headers: { origin: '' } })).status, 403);
  assert.equal((await submit({ token: '' })).status, 403);
  assert.equal((await submit({}, { headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
  assert.equal((await request(setup.url, { headers: { host: 'attacker.example' } })).status, 403);
  assert.equal((await request(new URL('/setup/guessed', setup.url))).status, 404);
  assert.equal((await request(`${setup.url}?password=anything`)).status, 404);
  assert.deepEqual(calls, []);
});

test('failed authentication never saves or exposes raw protocol error and permits retry', async t => {
  let attempts = 0;
  const { submit, calls } = await fixture(t, {
    verify: async () => {
      attempts++;
      if (attempts === 1) throw new Error('server transcript AUTH private-mailbox-password secret-user');
    },
  });
  const result = await submit();
  assert.equal(result.status, 400);
  assert.match(result.text, /Connection could not be verified/);
  assert.doesNotMatch(result.text, /private-mailbox-password|server transcript|secret-user/);
  assert.equal(calls.length, 0);
  assert.equal((await submit()).status, 200);
  assert.equal(calls.length, 1);
});

test('save errors are scrubbed and same mailbox reuses its existing identity', async t => {
  let saved;
  const { submit } = await fixture(t, {
    listAccounts: async () => [{ id: 'existing-account', email: 'Person@Example.pl', imap: { host: 'serwer123456.home.pl' } }],
    saveAccount: async (account) => { saved = account; throw new Error('Credential Manager private-mailbox-password'); },
  });
  const result = await submit();
  assert.equal(result.status, 500);
  assert.equal(saved.id, 'existing-account');
  assert.match(result.text, /account could not be saved/);
  assert.doesNotMatch(result.text, /private-mailbox-password/);
});

test('oversized forms, duplicate fields and malformed hosts never reach authentication', async t => {
  const { submit, calls, token } = await fixture(t);
  assert.equal((await submit({ imapHost: 'https://user:password@mail.example.pl/path' })).status, 400);
  assert.equal((await submit({}, { body: `token=${token}&token=${token}` })).status, 400);
  assert.equal((await submit({}, { body: 'x'.repeat(17000) })).status, 400);
  assert.equal((await submit({}, { headers: { 'content-type': 'application/json' } })).status, 400);
  assert.equal(calls.length, 0);
});

test('setup expires and cancellation resolves without saving', async t => {
  const { setup, calls } = await fixture(t, { timeoutMs: 60 });
  assert.deepEqual(await setup.completion, { status: 'expired' });
  assert.equal(calls.length, 0);
  await assert.rejects(request(setup.url));
  const other = await startSetup({ listAccounts: async () => [] });
  other.close();
  assert.deepEqual(await other.completion, { status: 'cancelled' });
});

test('a verification still pending at expiry cannot save credentials afterward', async t => {
  let release;
  let started;
  const verificationStarted = new Promise(resolve => { started = resolve; });
  const verification = new Promise(resolve => { release = resolve; });
  const { setup, submit, calls } = await fixture(t, {
    timeoutMs: 80,
    verify: async () => { started(); return verification; },
  });
  const pending = submit();
  await verificationStarted;
  assert.deepEqual(await setup.completion, { status: 'expired' });
  release({});
  assert.equal((await pending).status, 410);
  assert.equal(calls.length, 0);
});
