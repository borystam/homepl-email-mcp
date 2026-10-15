import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createConfigStore } from '../src/config.js';
import { createContext } from '../src/context.js';
import { startSetup } from '../src/setup.js';
import { makeServer } from '../src/server.js';

const password = 'synthetic-private-form-password';
const execution = { platform: 'win32', username: 'Employee', node: 'v24.19.0', dataDir: 'C:\\Users\\Employee\\AppData\\Local\\homepl-email-mcp' };

async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'homepl-mcp-onboarding-'));
  const credentials = new Map();
  const store = createConfigStore({ directory, keyring: {
    getPassword: async id => credentials.get(id) ?? null,
    setPassword: async (id, value) => { credentials.set(id, value); },
    deletePassword: async id => credentials.delete(id),
  } });
  let starts = 0;
  let verified = 0;
  const ctx = await createContext({ dataDir: directory });
  ctx.withImap = async (id, _folder, _options, fn) => {
    assert.equal(await store.getPassword(id), password);
    return fn({ list: async () => [{ path: 'INBOX', flags: new Set() }], status: async () => ({ messages: 0, uidValidity: 7n, uidNext: 1 }) });
  };
  const server = await makeServer({ ctx, listAccounts: store.listAccounts, readOnly: options.readOnly, onboarding: {
    getIdentity: () => ({ ...execution, dataDir: directory, ...options.identity }),
    startSetup: async () => {
      starts++;
      return startSetup({
        checkStorage: store.checkStorage, listAccounts: store.listAccounts, saveAccount: store.saveAccount,
        verify: async (_account, value) => { verified++; assert.equal(value, password); return {}; },
      });
    },
  } });
  const client = new Client({ name: 'private-onboarding-fixture', version: '1' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  t.after(async () => { await client.close(); await server.close(); await rm(directory, { recursive: true, force: true }); });
  const call = async (name, args = {}) => {
    const result = await client.callTool({ name, arguments: args });
    assert.doesNotMatch(JSON.stringify(result), new RegExp(password));
    assert.equal(result.isError, undefined);
    return JSON.parse(result.content[0].text);
  };
  return { client, server, store, credentials, call, counts: () => ({ starts, verified }) };
}

for (const readOnly of [false, true]) test(`native MCP connects via private form without shell setup (mail read-only=${readOnly})`, async t => {
  const f = await fixture(t, { readOnly });
  const tools = (await f.client.listTools()).tools;
  assert.equal(tools.length, readOnly ? 10 : 20);
  assert.equal(tools.find(tool => tool.name === 'mail_setup').annotations.readOnlyHint, false);
  assert.equal(tools.some(tool => tool.name === 'mail_send_prepared'), !readOnly);
  const connectorVersion = f.client.getServerVersion().version;
  const idle = await f.call('mail_setup_status');
  assert.equal(idle.status, 'idle');
  assert.equal(idle.connectorVersion, connectorVersion);
  const started = await f.call('mail_setup');
  assert.equal(started.status, 'pending');
  assert.equal(started.connectorVersion, connectorVersion);
  assert.equal(started.execution.username, 'Employee');
  assert.equal((await f.call('mail_setup')).url, started.url);
  assert.deepEqual(f.counts(), { starts: 1, verified: 0 });
  // A real local HTTP form is submitted with synthetic credentials. Passwords
  // never enter a tool call, config JSON, status response or process argument.
  const page = await fetch(started.url);
  const token = (await page.text()).match(/name="token" value="([^"]+)"/)[1];
  const response = await fetch(started.url, {
    method: 'POST', headers: { origin: new URL(started.url).origin, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token, email: 'employee@example.invalid', password, imapHost: 'mail.example.invalid' }),
  });
  assert.equal(response.status, 200);
  assert.doesNotMatch(await response.text(), new RegExp(password));
  const finished = await f.call('mail_setup_status');
  assert.equal(finished.status, 'connected');
  assert.equal(finished.connectorVersion, connectorVersion);
  assert.equal(finished.url, undefined);
  assert.equal(f.credentials.size, 1, 'storage probe removed its synthetic item; only the submitted credential remains');
  assert.equal((await f.call('mail_accounts')).accounts[0].id, finished.accountId);
  assert.equal((await f.call('mail_folders', { accountId: finished.accountId })).folders[0].path, 'INBOX');
  assert.deepEqual(f.counts(), { starts: 1, verified: 1 });
});

test('sandbox MCP identity is reported and blocked before a private form or storage probe starts', async t => {
  const f = await fixture(t, { identity: { username: 'CodexSandboxOnline' } });
  const result = await f.call('mail_setup');
  assert.equal(result.status, 'blocked');
  assert.equal(result.error, 'SETUP_REQUIRES_DESKTOP_USER');
  assert.equal(result.execution.username, 'CodexSandboxOnline');
  assert.equal(result.url, undefined);
  assert.deepEqual(f.counts(), { starts: 0, verified: 0 });
  assert.equal(f.credentials.size, 0);
});

test('onboarding tools reject password and arbitrary arguments without reflecting their values', async t => {
  const f = await fixture(t);
  for (const name of ['mail_setup', 'mail_setup_status']) {
    const response = await f.client.callTool({ name, arguments: { password, command: 'untrusted command' } });
    assert.equal(response.isError, true);
    assert.doesNotMatch(JSON.stringify(response), new RegExp(password));
  }
  assert.deepEqual(f.counts(), { starts: 0, verified: 0 });
});

test('MCP transport shutdown closes its active private HTTP form', async t => {
  const f = await fixture(t);
  const started = await f.call('mail_setup');
  await f.client.close();
  await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(fetch(started.url));
});
