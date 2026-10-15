import test from 'node:test';
import assert from 'node:assert/strict';
import { createOnboarding, onboardingErrorDescriptions } from '../src/onboarding.js';
import { configErrorDescriptions } from '../src/config.js';

const execution = { platform: 'win32', username: 'Employee', node: 'v24.19.0', dataDir: 'C:\\Users\\Employee\\AppData\\Local\\homepl-email-mcp' };
const getIdentity = () => ({ ...execution });
const url = 'http://127.0.0.1:54321/setup/synthetic-private-capability';
const deferred = () => { let resolve; let reject; const promise = new Promise((ok, fail) => { resolve = ok; reject = fail; }); return { promise, resolve, reject }; };
function wizard() {
  const completion = deferred();
  const result = { url, completion: completion.promise, closes: 0, finish: completion.resolve, fail: completion.reject };
  result.close = () => { result.closes++; result.finish({ status: 'cancelled' }); };
  return result;
}
const tick = () => new Promise(resolve => setImmediate(resolve));

test('onboarding checks the actual MCP identity and blocks a known Windows sandbox before touching storage', async () => {
  for (const username of ['CodexSandboxOnline', 'codexsandboxOffline', 'CODEXSANDBOX']) {
    const manager = createOnboarding({ getIdentity: () => ({ ...execution, username }), startSetup: () => assert.fail('sandbox attempted setup') });
    const result = await manager.start();
    assert.equal(result.status, 'blocked');
    assert.equal(result.error, 'SETUP_REQUIRES_DESKTOP_USER');
    assert.equal(result.message, onboardingErrorDescriptions.SETUP_REQUIRES_DESKTOP_USER);
    assert.equal(result.execution.username, username);
    assert.equal(result.url, undefined);
  }
});

test('an ordinary username still has to pass the real storage preflight and native failures stay sanitized', async () => {
  let attempts = 0;
  const manager = createOnboarding({ getIdentity, startSetup: async () => {
    attempts++;
    throw Object.assign(new Error('native secret-password no such logon session'), { code: 'CONFIG_CREDENTIAL_WRITE_FAILED', transcript: 'private' });
  } });
  const result = await manager.start();
  assert.equal(attempts, 1);
  assert.deepEqual(result, { status: 'blocked', error: 'CONFIG_CREDENTIAL_WRITE_FAILED', message: configErrorDescriptions.CONFIG_CREDENTIAL_WRITE_FAILED, execution });
  assert.doesNotMatch(JSON.stringify(manager.status()), /secret-password|no such logon|transcript/);
  await manager.start();
  assert.equal(attempts, 2, 'failed preflight may be retried after the launch context is repaired');
});

test('missing identity fails safely and unknown native codes are never returned', async () => {
  const missing = createOnboarding({ getIdentity: () => { throw new Error('private identity details'); }, startSetup: () => assert.fail('setup called without identity') });
  assert.equal((await missing.start()).error, 'SETUP_IDENTITY_UNAVAILABLE');
  assert.doesNotMatch(JSON.stringify(missing.status()), /private identity/);
  const unknown = createOnboarding({ getIdentity, startSetup: async () => { throw Object.assign(new Error('secret-password'), { code: 'SECRET_PASSWORD' }); } });
  assert.equal((await unknown.start()).error, 'SETUP_START_FAILED');
  assert.doesNotMatch(JSON.stringify(unknown.status()), /SECRET_PASSWORD|secret-password/);
});

test('concurrent starts share one wizard and active calls reuse its private URL', async () => {
  const started = deferred();
  const form = wizard();
  let calls = 0;
  const manager = createOnboarding({ getIdentity, startSetup: () => { calls++; return started.promise; } });
  const first = manager.start();
  const second = manager.start();
  assert.equal(first, second);
  assert.equal(manager.status().status, 'starting');
  assert.equal(calls, 1);
  started.resolve(form);
  const result = await first;
  assert.equal(result.status, 'pending');
  assert.equal(result.url, url);
  assert.equal((await manager.start()).url, url);
  assert.equal(calls, 1);
  result.execution.username = 'Changed outside';
  result.url = 'replaced';
  assert.equal(manager.status().execution.username, execution.username);
  assert.equal(manager.status().url, url);
  await manager.close();
  assert.equal(form.closes, 1);
});

test('successful completion returns only account identity, never form secrets or the retired capability', async () => {
  const form = wizard();
  const manager = createOnboarding({ getIdentity: () => ({ ...execution, extra: 'private-environment-value' }), startSetup: async () => form });
  await manager.start();
  form.finish({ status: 'connected', account: { id: 'synthetic-account', email: 'private@example.pl', password: 'private-password' }, url, extra: 'private' });
  await tick();
  const result = manager.status();
  assert.equal(result.status, 'connected');
  assert.equal(result.accountId, 'synthetic-account');
  assert.equal(result.url, undefined);
  assert.deepEqual(result.execution, execution);
  assert.doesNotMatch(JSON.stringify(result), /private-password|private@example|private-environment|synthetic-private-capability/);
  await manager.close();
  assert.equal(form.closes, 0);
});

test('expiry, cancellation and failures discard the capability and raw completion details', async () => {
  for (const final of [
    { status: 'expired', message: 'private-password' },
    { status: 'cancelled', url },
    { status: 'failed', message: 'private-password', account: { id: 'private-account' } },
    { status: 'unexpected', message: 'private-password' },
  ]) {
    const form = wizard();
    const manager = createOnboarding({ getIdentity, startSetup: async () => form });
    await manager.start();
    form.finish(final);
    await tick();
    const result = manager.status();
    assert.equal(result.status, ['expired', 'cancelled'].includes(final.status) ? final.status : 'failed');
    assert.equal(result.url, undefined);
    assert.doesNotMatch(JSON.stringify(result), /private-password|private-account|synthetic-private-capability|unexpected/);
  }
});

test('a rejected wizard completion is sanitized without an unhandled rejection', async () => {
  const form = wizard();
  const manager = createOnboarding({ getIdentity, startSetup: async () => form });
  await manager.start();
  form.fail(new Error('private-password provider transcript'));
  await tick();
  assert.equal(manager.status().error, 'SETUP_FAILED');
  assert.doesNotMatch(JSON.stringify(manager.status()), /private-password|provider transcript/);
});

test('closing during startup cancels a late wizard and permanently prevents new starts', async () => {
  const started = deferred();
  const form = wizard();
  let calls = 0;
  const manager = createOnboarding({ getIdentity, startSetup: () => { calls++; return started.promise; } });
  const pending = manager.start();
  const closing = manager.close();
  assert.equal(manager.status().status, 'cancelled');
  started.resolve(form);
  assert.equal((await pending).status, 'cancelled');
  await closing;
  assert.equal(form.closes, 1);
  assert.equal((await manager.start()).status, 'cancelled');
  assert.equal(calls, 1);
  assert.equal(manager.status().url, undefined);
});

test('closed active wizard cannot later replace cancelled state with a connected response', async () => {
  const form = wizard();
  form.close = () => { form.closes++; form.finish({ status: 'connected', account: { id: 'synthetic-account' } }); };
  const manager = createOnboarding({ getIdentity, startSetup: async () => form });
  await manager.start();
  await manager.close();
  await tick();
  assert.equal(manager.status().status, 'cancelled');
  assert.equal(manager.status().accountId, undefined);
  assert.equal(form.closes, 1);
});

test('setup rejects non-loopback or credential-bearing URLs and closes the unexpected wizard', async () => {
  for (const invalid of ['https://attacker.example/setup/token', 'http://127.0.0.1:54321/setup/token?password=private', 'http://user:private@127.0.0.1:54321/setup/token', 'http://127.0.0.1:54321/other/token']) {
    const form = { ...wizard(), url: invalid };
    const manager = createOnboarding({ getIdentity, startSetup: async () => form });
    const result = await manager.start();
    assert.equal(result.error, 'SETUP_START_FAILED');
    assert.equal(result.url, undefined);
    assert.doesNotMatch(JSON.stringify(result), /attacker|password=|user:private/);
    // The copied fake retains its original close closure; the completion proves shutdown.
    assert.equal((await form.completion).status, 'cancelled');
  }
});
