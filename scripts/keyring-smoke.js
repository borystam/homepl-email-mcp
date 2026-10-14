#!/usr/bin/env node
// CI/operator smoke check across fresh Node processes, not just an in-memory entry.
// Uses a new synthetic service/account and deletes it afterward. Never touches
// existing user credentials or contacts a mail server. This is not a reboot test.
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createConfigStore } from '../src/config.js';

async function worker() {
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk;
    assert.ok(Buffer.byteLength(input) <= 16 * 1024);
  }
  const { action, directory, service, id, password, nextPassword } = JSON.parse(input);
  // Refuse to use the worker against a real account or credential service.
  const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
  assert.match(service, new RegExp(`^homepl-email-mcp\\.smoke-test\\.${uuid}$`));
  assert.match(id, new RegExp(`^smoke-${uuid}$`));
  const { AsyncEntry } = await import('@napi-rs/keyring');
  const entry = new AsyncEntry(service, id, { linux: { store: 'secret-service' } });
  const store = createConfigStore({ directory, keyring: {
    async getPassword(accountId) { assert.equal(accountId, id); return entry.getPassword(); },
    async setPassword(accountId, value) { assert.equal(accountId, id); return entry.setPassword(value); },
    async deletePassword(accountId) { assert.equal(accountId, id); return entry.deletePassword(); },
  } });
  const account = {
    id, email: 'smoke@example.invalid',
    imap: { host: 'imap.example.invalid', port: 993 },
    smtp: { host: 'smtp.example.invalid', port: 465 }, folders: {},
  };
  if (action === 'save') {
    assert.deepEqual(await store.listAccounts(), []);
    assert.equal(await entry.getPassword(), null);
    await store.saveAccount(account, password);
    assert.equal(await store.getPassword(id), password);
    const metadata = await readFile(join(directory, 'accounts.json'), 'utf8');
    assert.ok(!metadata.includes(password));
  } else if (action === 'reopen-and-rotate') {
    assert.deepEqual(await store.getAccount(id), account);
    assert.equal(await store.getPassword(id), password);
    await store.saveAccount(account, nextPassword);
    assert.equal(await store.getPassword(id), nextPassword);
    const metadata = await readFile(join(directory, 'accounts.json'), 'utf8');
    assert.ok(!metadata.includes(password) && !metadata.includes(nextPassword));
  } else if (action === 'reopen-and-remove') {
    assert.deepEqual(await store.getAccount(id), account);
    assert.equal(await store.getPassword(id), password);
    await store.removeAccount(id);
  } else if (action === 'verify-removed') {
    assert.deepEqual(await store.listAccounts(), []);
    assert.equal(await entry.getPassword(), null);
  } else if (action === 'cleanup') {
    await entry.deletePassword();
    assert.equal(await entry.getPassword(), null);
  } else {
    throw new Error('Unknown smoke-test operation.');
  }
  process.stdout.write('ok\n');
}

function runWorker(request) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--worker'], {
      stdio: ['pipe', 'pipe', 'pipe'], timeout: 30_000,
    });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    // A native error could include a credential. Never forward child diagnostics.
    child.stderr.resume();
    child.on('error', reject);
    child.stdin.on('error', reject);
    child.on('close', code => {
      if (code === 0 && output === 'ok\n') resolve();
      else reject(new Error('Synthetic credential worker failed.'));
    });
    // Synthetic passwords travel over a pipe, never arguments, env, or disk.
    child.stdin.end(JSON.stringify(request));
  });
}

async function smoke() {
  const directory = await mkdtemp(join(tmpdir(), 'homepl-keyring-smoke-'));
  const identity = {
    directory, service: `homepl-email-mcp.smoke-test.${randomUUID()}`, id: `smoke-${randomUUID()}`,
  };
  const password = randomBytes(32).toString('base64url');
  const rotated = randomBytes(32).toString('base64url');
  let failure = false;
  let stage = 'save';
  try {
    for (const operation of [
      { action: 'save', password },
      { action: 'reopen-and-rotate', password, nextPassword: rotated },
      { action: 'reopen-and-remove', password: rotated },
      { action: 'verify-removed' },
    ]) {
      stage = operation.action;
      await runWorker({ ...identity, ...operation });
    }
  } catch {
    failure = true;
  } finally {
    try { await runWorker({ ...identity, action: 'cleanup' }); }
    catch { failure = true; stage = 'cleanup'; }
    try { await rm(directory, { recursive: true, force: true }); }
    catch { failure = true; stage = 'temporary-file cleanup'; }
  }
  if (failure) {
    process.stderr.write(`Native credential store check failed during ${stage}. Ensure the operating system credential store is available and unlocked.\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write(`Native credential store save/reopen/rotate/reopen/remove check passed across fresh Node processes on ${process.platform}. This does not test an OS reboot.\n`);
  }
}

try {
  if (process.argv.length === 3 && process.argv[2] === '--worker') await worker();
  else if (process.argv.length === 2) await smoke();
  else throw new Error('Invalid smoke-test arguments.');
} catch {
  process.stderr.write('Native credential store check failed.\n');
  process.exitCode = 1;
}
