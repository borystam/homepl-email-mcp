import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join, resolve } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { createConfigStore, validateAccount, dataDir } from '../src/config.js';

const account = (id = 'test-account') => ({
  id, email: 'person@example.pl', displayName: 'Test Person',
  imap: { host: 'serwer123456.home.pl', port: 993 },
  smtp: { host: 'serwer123456.home.pl', port: 465 }, folders: { sent: 'Wysłane' },
});

async function fixture(t, customKeyring) {
  const directory = await mkdtemp(join(tmpdir(), 'homepl-config-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const secrets = new Map();
  const keyring = customKeyring || {
    async getPassword(id) { return secrets.get(id) ?? null; },
    async setPassword(id, password) { secrets.set(id, password); },
    async deletePassword(id) { return secrets.delete(id); },
  };
  return { directory, secrets, keyring, store: createConfigStore({ directory, keyring }) };
}

test('data directory uses the native per-user location and supports an explicit override', () => {
  const previous = process.env.HOME_MAIL_DATA_DIR;
  try {
    delete process.env.HOME_MAIL_DATA_DIR;
    const expected = process.platform === 'win32'
      ? join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'homepl-email-mcp')
      : join(homedir(), '.local', 'share', 'homepl-email-mcp');
    assert.equal(dataDir(), resolve(expected));
    process.env.HOME_MAIL_DATA_DIR = join(tmpdir(), 'explicit-homepl-test-directory');
    assert.equal(dataDir(), resolve(process.env.HOME_MAIL_DATA_DIR));
  } finally {
    if (previous === undefined) delete process.env.HOME_MAIL_DATA_DIR;
    else process.env.HOME_MAIL_DATA_DIR = previous;
  }
});

test('account metadata persists without secret material; password stays in injected OS-keyring adapter', async t => {
  const { directory, secrets, store } = await fixture(t);
  const saved = await store.saveAccount({ ...account(), password: 'injected-secret', auth: { pass: 'another-secret' } }, 'actual-password');
  assert.deepEqual(saved, account());
  assert.equal(secrets.get('test-account'), 'actual-password');
  assert.equal(await store.getPassword('test-account'), 'actual-password');
  assert.deepEqual(await store.getAccount('test-account'), account());
  const raw = await readFile(join(directory, 'accounts.json'), 'utf8');
  assert.doesNotMatch(raw, /actual-password|injected-secret|another-secret|password|auth/);
  assert.deepEqual(await readdir(directory), ['accounts.json']);
  if (process.platform !== 'win32') {
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
    assert.equal((await stat(join(directory, 'accounts.json'))).mode & 0o777, 0o600);
  }
  await store.removeAccount('test-account');
  assert.equal(secrets.has('test-account'), false);
  assert.deepEqual(await store.listAccounts(), []);
  await assert.rejects(store.getPassword('test-account'), /not found/);
});

test('concurrent saves preserve both accounts and replacement rotates only one credential', async t => {
  const { store } = await fixture(t);
  await Promise.all([store.saveAccount(account('a'), 'password-a'), store.saveAccount(account('b'), 'password-b')]);
  assert.deepEqual((await store.listAccounts()).map(a => a.id).sort(), ['a', 'b']);
  await store.saveAccount({ ...account('a'), displayName: 'Updated' }, 'rotated-a');
  assert.equal(await store.getPassword('a'), 'rotated-a');
  assert.equal(await store.getPassword('b'), 'password-b');
  assert.equal((await store.listAccounts()).length, 2);
});

test('locked credential store fails closed with no disk password fallback or leaked native error', async t => {
  const { store, directory } = await fixture(t, {
    async getPassword() { throw new Error('native private-password AUTH transcript'); },
  });
  await assert.rejects(store.saveAccount(account(), 'private-password'), error => {
    assert.equal(error.code, 'CONFIG_CREDENTIAL_READ_FAILED');
    assert.match(error.message, /credential store/);
    assert.doesNotMatch(error.message, /private-password|transcript/);
    return true;
  });
  assert.deepEqual(await readdir(directory), []);
});

test('invalid ports, credential-bearing URLs, path IDs and control characters are rejected before saving', async t => {
  const { store, secrets } = await fixture(t);
  for (const input of [
    { ...account(), id: '../escape' },
    { ...account(), email: 'person@example.pl\r\nBcc: victim@example.pl' },
    { ...account(), imap: { host: 'serwer123456.home.pl', port: 143 } },
    { ...account(), smtp: { host: 'smtp://user:secret@example.pl', port: 465 } },
    { ...account(), imap: { host: '127.0.0.1', port: 993 } },
    { ...account(), folders: { trash: 'Trash\0Injected' } },
  ]) await assert.rejects(store.saveAccount(input, 'secret'));
  assert.equal(secrets.size, 0);
  assert.equal(validateAccount({ ...account(), imap: { host: 'MAIL.EXAMPLE.PL', port: 993 } }).imap.host, 'mail.example.pl');
});

test('config refuses symlink files instead of reading unrelated files', async t => {
  const { directory, store } = await fixture(t);
  const target = join(directory, 'outside.json');
  await writeFile(target, JSON.stringify({ version: 1, accounts: [account()] }));
  await symlink(target, join(directory, 'accounts.json'));
  await assert.rejects(store.listAccounts(), /could not be read/);
});

test('independent config stores refuse overlapping mutations instead of losing another account', async t => {
  const { directory, keyring, store } = await fixture(t);
  const other = createConfigStore({ directory, keyring });
  let release;
  let started;
  const entered = new Promise(resolve => { started = resolve; });
  const blocked = new Promise(resolve => { release = resolve; });
  const setPassword = keyring.setPassword;
  keyring.setPassword = async (id, password) => {
    await setPassword(id, password);
    if (id === 'a') { started(); await blocked; }
  };
  const saving = store.saveAccount(account('a'), 'password-a');
  await entered;
  try {
    await assert.rejects(other.saveAccount(account('b'), 'password-b'), { code: 'CONFIG_BUSY' });
    await assert.rejects(other.removeAccount('a'), { code: 'CONFIG_BUSY' });
    const child = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', `
      const { createConfigStore } = await import(process.argv[1]);
      const store = createConfigStore({ directory: process.argv[2], keyring: {
        async getPassword() { throw new Error('Unexpected keyring access'); }
      } });
      try {
        await store.removeAccount('a');
        process.exitCode = 1;
      } catch (error) {
        if (error.code !== 'CONFIG_BUSY') throw error;
        process.stdout.write(error.code);
      }
    `, new URL('../src/config.js', import.meta.url).href, directory]);
    assert.equal(child.stdout, 'CONFIG_BUSY');
    assert.equal(child.stderr, '');
  } finally {
    release();
    await saving;
  }
  await other.saveAccount(account('b'), 'password-b');
  assert.deepEqual((await store.listAccounts()).map(a => a.id).sort(), ['a', 'b']);
  assert.equal(await store.getPassword('a'), 'password-a');
  assert.equal(await other.getPassword('b'), 'password-b');
});

test('credential writes that change a secret and then fail restore the previous credential', async t => {
  const { store, keyring, secrets } = await fixture(t);
  await store.saveAccount(account(), 'old-password');
  keyring.setPassword = async (id, password) => {
    secrets.set(id, password);
    if (password === 'new-password') throw new Error('native secret new-password AUTH transcript');
  };
  await assert.rejects(store.saveAccount({ ...account(), displayName: 'Should not persist' }, 'new-password'), error => {
    assert.equal(error.code, 'CONFIG_CREDENTIAL_WRITE_FAILED');
    assert.doesNotMatch(error.message, /new-password|AUTH|transcript/);
    return true;
  });
  assert.equal(await store.getPassword('test-account'), 'old-password');
  assert.equal((await store.getAccount('test-account')).displayName, 'Test Person');
});

test('credential deletion that takes effect and then fails restores the account credential', async t => {
  const { store, keyring, secrets } = await fixture(t);
  await store.saveAccount(account(), 'old-password');
  keyring.deletePassword = async id => {
    secrets.delete(id);
    throw new Error('native private-password deletion transcript');
  };
  await assert.rejects(store.removeAccount('test-account'), error => {
    assert.equal(error.code, 'CONFIG_CREDENTIAL_DELETE_FAILED');
    assert.doesNotMatch(error.message, /private-password|transcript/);
    return true;
  });
  assert.equal(await store.getPassword('test-account'), 'old-password');
  assert.deepEqual(await store.getAccount('test-account'), account());
});

test('a pre-cancelled save never accesses the credential store or changes metadata', async t => {
  const { store, directory } = await fixture(t, {
    async getPassword() { assert.fail('cancelled save accessed keyring'); },
  });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(store.saveAccount(account(), 'secret', { signal: controller.signal }), { code: 'CONFIG_CANCELLED' });
  assert.deepEqual(await readdir(directory), []);
});

test('cancellation after credential rotation rolls back before reporting completion', async t => {
  const { store, keyring, secrets } = await fixture(t);
  await store.saveAccount(account(), 'old-password');
  const controller = new AbortController();
  keyring.setPassword = async (id, password) => {
    secrets.set(id, password);
    if (password === 'new-password') controller.abort();
  };
  await assert.rejects(store.saveAccount({ ...account(), displayName: 'Should not persist' }, 'new-password', { signal: controller.signal }), { code: 'CONFIG_CANCELLED' });
  assert.equal(await store.getPassword('test-account'), 'old-password');
  assert.equal((await store.getAccount('test-account')).displayName, 'Test Person');
});

test('a failed metadata write removes a new credential and temporary files', async t => {
  const { directory, store, keyring, secrets } = await fixture(t);
  const setPassword = keyring.setPassword;
  keyring.setPassword = async (id, password) => {
    await setPassword(id, password);
    // Force the final file replacement to fail after the keyring write.
    await mkdir(join(directory, 'accounts.json'));
  };
  await assert.rejects(store.saveAccount(account(), 'private-password'), { code: 'CONFIG_SETTINGS_WRITE_FAILED' });
  assert.equal(secrets.size, 0);
  assert.deepEqual(await readdir(directory), ['accounts.json']);
});

test('failed credential rollback is reported as recovery required without native error details', async t => {
  const { store, keyring, secrets } = await fixture(t);
  await store.saveAccount(account(), 'old-password');
  keyring.setPassword = async (id, password) => {
    if (password === 'new-password') secrets.set(id, password);
    throw new Error('native private-password AUTH transcript');
  };
  await assert.rejects(store.saveAccount(account(), 'new-password'), error => {
    assert.equal(error.code, 'CONFIG_RECOVERY_REQUIRED');
    assert.match(error.message, /could not be fully restored/);
    assert.doesNotMatch(error.message, /private-password|AUTH|transcript/);
    return true;
  });
});

test('an existing lock is never automatically treated as stale or removed', async t => {
  const { directory, store, secrets } = await fixture(t);
  const sentinel = '{"pid":99999999,"createdAt":"2000-01-01T00:00:00.000Z"}\n';
  await writeFile(join(directory, '.accounts.lock'), sentinel, { mode: 0o600 });
  await assert.rejects(store.saveAccount(account(), 'private-password'), { code: 'CONFIG_BUSY' });
  await assert.rejects(store.checkStorage(), { code: 'CONFIG_BUSY' });
  assert.equal(await readFile(join(directory, '.accounts.lock'), 'utf8'), sentinel);
  assert.equal(secrets.size, 0);
});

test('storage preflight checks the actual directory and synthetic credential without modifying accounts', async t => {
  const { store, keyring, secrets, directory } = await fixture(t);
  await store.saveAccount(account(), 'real-test-account-password');
  const before = await readFile(join(directory, 'accounts.json'), 'utf8');
  const ids = new Set();
  let testPassword;
  const setPassword = keyring.setPassword;
  keyring.setPassword = async (id, password) => {
    assert.match(id, /^storage-check-[0-9a-f-]{36}$/);
    ids.add(id);
    testPassword = password;
    // The synthetic credential must never be written into any probe file.
    for (const name of await readdir(directory)) {
      assert.ok(!(await readFile(join(directory, name), 'utf8')).includes(password));
    }
    await setPassword(id, password);
  };
  assert.deepEqual(await store.checkStorage(), { directory: 'writable', credentials: 'available' });
  assert.equal(ids.size, 1);
  assert.ok(testPassword.length >= 32);
  assert.equal(await readFile(join(directory, 'accounts.json'), 'utf8'), before);
  assert.deepEqual([...secrets], [['test-account', 'real-test-account-password']]);
  assert.deepEqual(await readdir(directory), ['accounts.json']);
});

test('storage preflight reports a blocked data directory before accessing credentials', async t => {
  const { directory } = await fixture(t);
  const blocked = join(directory, 'not-a-directory');
  await writeFile(blocked, 'private path material');
  const store = createConfigStore({ directory: blocked, keyring: {
    async getPassword() { assert.fail('blocked directory accessed keyring'); },
  } });
  await assert.rejects(store.checkStorage(), error => {
    assert.equal(error.code, 'CONFIG_DIRECTORY_UNWRITABLE');
    assert.doesNotMatch(error.message, /not-a-directory|private path material|ENOENT|EEXIST/);
    return true;
  });
  assert.equal(await readFile(blocked, 'utf8'), 'private path material');
});

test('storage preflight distinguishes binding initialization and credential read failures without native details', async t => {
  for (const [nativeCode, expectedCode] of [
    ['CONFIG_CREDENTIAL_BINDING_FAILED', 'CONFIG_CREDENTIAL_BINDING_FAILED'],
    ['GenericFailure', 'CONFIG_CREDENTIAL_READ_FAILED'],
  ]) {
    const { store, directory } = await fixture(t, {
      async getPassword() { throw Object.assign(new Error('native private-password transcript'), { code: nativeCode }); },
      async setPassword() { assert.fail('failed read attempted a write'); },
      async deletePassword() { assert.fail('failed read attempted a delete'); },
    });
    await assert.rejects(store.checkStorage(), error => {
      assert.equal(error.code, expectedCode);
      assert.doesNotMatch(error.message, /private-password|transcript|GenericFailure/);
      return true;
    });
    assert.deepEqual(await readdir(directory), []);
  }
});

test('storage preflight cleans up a credential write that takes effect and then fails', async t => {
  const { store, keyring, secrets, directory } = await fixture(t);
  keyring.setPassword = async (id, password) => {
    secrets.set(id, password);
    throw new Error('private native write transcript');
  };
  await assert.rejects(store.checkStorage(), { code: 'CONFIG_CREDENTIAL_WRITE_FAILED' });
  assert.equal(secrets.size, 0);
  assert.deepEqual(await readdir(directory), []);
});

test('storage preflight fails if credential readback does not match and still removes its test entry', async t => {
  const { store, keyring, secrets, directory } = await fixture(t);
  const getPassword = keyring.getPassword;
  keyring.getPassword = async id => secrets.has(id) ? 'wrong-readback-value' : getPassword(id);
  await assert.rejects(store.checkStorage(), { code: 'CONFIG_CREDENTIAL_READ_FAILED' });
  assert.equal(secrets.size, 0);
  assert.deepEqual(await readdir(directory), []);
});

test('storage preflight never overwrites or deletes a colliding credential', async t => {
  const { store, directory } = await fixture(t, {
    async getPassword() { return 'existing-credential'; },
    async setPassword() { assert.fail('preflight overwrote an existing credential'); },
    async deletePassword() { assert.fail('preflight deleted an existing credential'); },
  });
  await assert.rejects(store.checkStorage(), { code: 'CONFIG_CREDENTIAL_READ_FAILED' });
  assert.deepEqual(await readdir(directory), []);
});

test('storage preflight reports failed credential cleanup and removes its temporary files', async t => {
  const { store, keyring, secrets, directory } = await fixture(t);
  keyring.deletePassword = async () => { throw new Error('native cleanup private-password'); };
  await assert.rejects(store.checkStorage(), error => {
    assert.equal(error.code, 'CONFIG_CREDENTIAL_DELETE_FAILED');
    assert.doesNotMatch(error.message, /private-password|native cleanup/);
    return true;
  });
  assert.equal(secrets.size, 1);
  assert.deepEqual(await readdir(directory), []);
});

test('storage preflight detects a deletion reported successful while a test credential remains', async t => {
  const { store, keyring, secrets, directory } = await fixture(t);
  keyring.deletePassword = async () => true;
  await assert.rejects(store.checkStorage(), { code: 'CONFIG_CREDENTIAL_DELETE_FAILED' });
  assert.equal(secrets.size, 1);
  assert.deepEqual(await readdir(directory), []);
});

test('storage preflight flags incomplete recovery when both an operation and cleanup fail', async t => {
  const { store, keyring, directory } = await fixture(t);
  keyring.setPassword = async () => { throw new Error('native credential write failed'); };
  keyring.deletePassword = async () => { throw new Error('native credential cleanup failed'); };
  await assert.rejects(store.checkStorage(), { code: 'CONFIG_STORAGE_CLEANUP_FAILED' });
  assert.deepEqual(await readdir(directory), []);
});

test('unreadable settings report a fixed code without leaking corrupt file contents', async t => {
  const { store, directory } = await fixture(t);
  await writeFile(join(directory, 'accounts.json'), 'private-mailbox-data invalid JSON');
  await assert.rejects(store.listAccounts(), error => {
    assert.equal(error.code, 'CONFIG_SETTINGS_READ_FAILED');
    assert.doesNotMatch(error.message, /private-mailbox-data|invalid JSON|SyntaxError/);
    return true;
  });
  await assert.rejects(store.checkStorage(), { code: 'CONFIG_SETTINGS_READ_FAILED' });
  assert.deepEqual(await readdir(directory), ['accounts.json']);
  assert.equal(await readFile(join(directory, 'accounts.json'), 'utf8'), 'private-mailbox-data invalid JSON');
});
