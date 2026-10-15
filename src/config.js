import { mkdir, open, readFile, writeFile, rename, unlink, lstat, chmod } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve, join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';

const SERVICE = 'ccservices.homepl-email-mcp';
const SAFE_ID = /^[A-Za-z0-9_-]{1,80}$/;
export const configErrorDescriptions = Object.freeze({
  CONFIG_BUSY: 'Another account update is active. Wait for it to finish before retrying. If a setup process crashed, close all setup processes before manually removing .accounts.lock from the mail data directory.',
  CONFIG_CANCELLED: 'Account setup was cancelled before completion. No new account settings were retained.',
  CONFIG_RECOVERY_REQUIRED: 'An account update failed and its previous settings or credential could not be fully restored. Check the account and run setup again before using it.',
  CONFIG_LOCK_RELEASE_FAILED: 'The account update finished, but its lock could not be removed. Inspect the saved accounts before retrying; close setup processes before manually removing .accounts.lock.',
  CONFIG_DIRECTORY_UNWRITABLE: 'The local mail data directory could not be created or written. Run the connector as the logged-in desktop user and check that this user can write to its data directory.',
  CONFIG_SETTINGS_READ_FAILED: 'Mail account settings could not be read. Check the local accounts.json file; do not replace or delete existing settings automatically.',
  CONFIG_SETTINGS_WRITE_FAILED: 'Account settings could not be saved. Check that the mail data directory is writable and that security software permits the connector to update its settings.',
  CONFIG_CREDENTIAL_BINDING_FAILED: 'The native OS credential-store component could not be loaded or initialized. Check the native Node.js installation and reinstall this release’s dependencies, including optional platform packages.',
  CONFIG_CREDENTIAL_READ_FAILED: 'The OS credential store could not be read. Run the connector as the same logged-in desktop user who completed setup and allow access to that user’s credential store.',
  CONFIG_CREDENTIAL_WRITE_FAILED: 'The OS credential store could not save a credential. Run setup as the logged-in desktop user with access to that user’s credential store; check whether an agent sandbox or security policy blocks credential access.',
  CONFIG_CREDENTIAL_DELETE_FAILED: 'The OS credential store could not remove a credential. Run the connector as the same logged-in desktop user and check that credential-store access is permitted.',
  CONFIG_STORAGE_CLEANUP_FAILED: 'The storage check could not fully remove its synthetic test data. Check access to the local data directory and OS credential store before retrying setup.',
});
const configError = code => Object.assign(new Error(configErrorDescriptions[code]), { code });
const checkCancelled = signal => { if (signal?.aborted) throw configError('CONFIG_CANCELLED'); };

export function dataDir() {
  const defaultDirectory = process.platform === 'win32'
    ? join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'homepl-email-mcp')
    : join(homedir(), '.local', 'share', 'homepl-email-mcp');
  return resolve(process.env.HOME_MAIL_DATA_DIR || defaultDirectory);
}

function validateId(id) {
  if (typeof id !== 'string' || !SAFE_ID.test(id)) throw new Error('Invalid account ID.');
  return id;
}

export function validateHostname(value) {
  if (typeof value !== 'string') throw new Error('Enter the exact mail server hostname.');
  const host = value.trim().toLowerCase();
  if (host.length > 253 || !host.includes('.') || /^\d+(?:\.\d+){3}$/.test(host) ||
      !host.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) {
    throw new Error('Enter a DNS hostname such as serwer123456.home.pl, without a URL, path, or port.');
  }
  return host;
}

export function validateAccount(input) {
  if (!input || typeof input !== 'object') throw new Error('Invalid account settings.');
  const id = validateId(input.id);
  const email = typeof input.email === 'string' ? input.email.trim() : '';
  if (email.length > 254 || !/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(email) || /[\x00-\x1f\x7f]/.test(email)) {
    throw new Error('Enter the full mailbox email address.');
  }
  if (input.imap?.port !== 993 || input.smtp?.port !== 465) throw new Error('Only encrypted IMAP port 993 and SMTP port 465 are supported.');
  const account = {
    id, email,
    imap: { host: validateHostname(input.imap.host), port: 993 },
    smtp: { host: validateHostname(input.smtp.host), port: 465 },
    folders: {},
  };
  if (input.displayName !== undefined && input.displayName !== '') {
    if (typeof input.displayName !== 'string' || input.displayName.length > 200 || /[\x00-\x1f\x7f]/.test(input.displayName)) throw new Error('Invalid display name.');
    account.displayName = input.displayName;
  }
  for (const name of ['sent', 'drafts', 'trash']) {
    const value = input.folders?.[name];
    if (value !== undefined && value !== '') {
      if (typeof value !== 'string' || value.length > 1024 || /[\x00-\x1f\x7f]/.test(value)) throw new Error('Invalid special folder name.');
      account.folders[name] = value;
    }
  }
  return account;
}

async function nativeEntry(id) {
  try {
    // Lazy loading lets setup/tests run without loading a platform binary first.
    const { AsyncEntry } = await import('@napi-rs/keyring');
    return new AsyncEntry(SERVICE, id, { linux: { store: 'secret-service' } });
  } catch {
    throw configError('CONFIG_CREDENTIAL_BINDING_FAILED');
  }
}

const nativeKeyring = {
  async getPassword(id) { return (await nativeEntry(id)).getPassword(); },
  async setPassword(id, password) { return (await nativeEntry(id)).setPassword(password); },
  async deletePassword(id) { return (await nativeEntry(id)).deletePassword(); },
};

// Adapter injection is for isolated tests; the production store always uses the OS keyring.
export function createConfigStore({ directory = dataDir, keyring = nativeKeyring } = {}) {
  const root = () => resolve(typeof directory === 'function' ? directory() : directory);
  const filename = () => join(root(), 'accounts.json');
  let pending = Promise.resolve();
  const serial = operation => {
    const result = pending.then(operation, operation);
    pending = result.catch(() => {});
    return result;
  };

  async function ensureDirectory() {
    try {
      await mkdir(root(), { recursive: true, mode: 0o700 });
      const stat = await lstat(root());
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error();
      if (process.platform !== 'win32') await chmod(root(), 0o700);
    } catch { throw configError('CONFIG_DIRECTORY_UNWRITABLE'); }
  }

  // The promise queue handles this instance; the exclusive file also protects
  // against a second setup process reading and replacing the same old snapshot.
  // A leftover lock is deliberately not stolen: an interrupted keyring change
  // needs operator inspection rather than a guessed stale-process timeout.
  async function mutate(operation, signal) {
    return serial(async () => {
      checkCancelled(signal);
      await ensureDirectory();
      const lockPath = join(root(), '.accounts.lock');
      let lock;
      try { lock = await open(lockPath, 'wx', 0o600); }
      catch (error) {
        if (error.code === 'EEXIST') throw configError('CONFIG_BUSY');
        throw configError('CONFIG_DIRECTORY_UNWRITABLE');
      }
      try {
        try { await lock.writeFile(`${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`); }
        catch { throw configError('CONFIG_DIRECTORY_UNWRITABLE'); }
        checkCancelled(signal);
        return await operation();
      } finally {
        let releaseFailed = false;
        try { await lock.close(); } catch { releaseFailed = true; }
        try { await unlink(lockPath); } catch { releaseFailed = true; }
        if (releaseFailed) throw configError('CONFIG_LOCK_RELEASE_FAILED');
      }
    });
  }

  async function readAccounts() {
    try {
      const stat = await lstat(filename());
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) throw new Error();
      const config = JSON.parse(await readFile(filename(), 'utf8'));
      if (config.version !== 1 || !Array.isArray(config.accounts)) throw new Error();
      const accounts = config.accounts.map(validateAccount);
      if (new Set(accounts.map(a => a.id)).size !== accounts.length) throw new Error();
      return accounts;
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw configError('CONFIG_SETTINGS_READ_FAILED');
    }
  }

  async function writeAccounts(accounts) {
    await ensureDirectory();
    const temporary = join(root(), `.accounts-${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, `${JSON.stringify({ version: 1, accounts }, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
      await rename(temporary, filename());
    } catch { throw configError('CONFIG_SETTINGS_WRITE_FAILED');
    } finally {
      await unlink(temporary).catch(() => {});
    }
  }

  async function keyringCall(method, ...args) {
    try { return await keyring[method](...args); }
    catch (error) {
      if (error?.code === 'CONFIG_CREDENTIAL_BINDING_FAILED') throw configError(error.code);
      throw configError({ getPassword: 'CONFIG_CREDENTIAL_READ_FAILED', setPassword: 'CONFIG_CREDENTIAL_WRITE_FAILED', deletePassword: 'CONFIG_CREDENTIAL_DELETE_FAILED' }[method]);
    }
  }

  // Prove the actual data directory and credential context work before asking
  // for a mailbox password. Test entries never become configured accounts.
  async function checkStorage() {
    return mutate(async () => {
      await readAccounts();
      const probe = `storage-check-${randomUUID()}`;
      const paths = [join(root(), `.${probe}.tmp`), join(root(), `.${probe}.replace.tmp`)];
      const ownedPaths = new Set();
      const marker = 'homepl-email-mcp synthetic storage check\n';
      let password = randomBytes(32).toString('base64url');
      let credentialMayExist = false;
      let failure;
      let cleanupFailure;
      try {
        try {
          for (const path of paths) {
            const handle = await open(path, 'wx', 0o600);
            ownedPaths.add(path);
            try { await handle.writeFile(marker); } finally { await handle.close(); }
          }
          if (await readFile(paths[0], 'utf8') !== marker) throw new Error();
          await rename(paths[0], paths[1]);
          ownedPaths.delete(paths[0]);
          if (await readFile(paths[1], 'utf8') !== marker) throw new Error();
        } catch { throw configError('CONFIG_DIRECTORY_UNWRITABLE'); }
        // Refuse even an extremely unlikely collision instead of overwriting.
        if (await keyringCall('getPassword', probe) != null) throw configError('CONFIG_CREDENTIAL_READ_FAILED');
        credentialMayExist = true;
        await keyringCall('setPassword', probe, password);
        if (await keyringCall('getPassword', probe) !== password) throw configError('CONFIG_CREDENTIAL_READ_FAILED');
      } catch (error) { failure = error; }
      finally {
        password = undefined;
        if (credentialMayExist) {
          try {
            await keyringCall('deletePassword', probe);
            if (await keyringCall('getPassword', probe) != null) throw configError('CONFIG_CREDENTIAL_DELETE_FAILED');
          } catch (error) { cleanupFailure = error; }
        }
        for (const path of ownedPaths) {
          try { await unlink(path); }
          catch (error) { if (error.code !== 'ENOENT') cleanupFailure = configError('CONFIG_STORAGE_CLEANUP_FAILED'); }
        }
      }
      if (cleanupFailure) throw failure ? configError('CONFIG_STORAGE_CLEANUP_FAILED') : cleanupFailure;
      if (failure) throw failure;
      return { directory: 'writable', credentials: 'available' };
    });
  }

  async function listAccounts() { return readAccounts(); }
  async function getAccount(id) {
    validateId(id);
    const account = (await readAccounts()).find(a => a.id === id);
    if (!account) throw new Error('Mail account not found. Run homepl-email-mcp setup first.');
    return account;
  }
  async function getPassword(id) {
    await getAccount(id);
    const password = await keyringCall('getPassword', id);
    if (typeof password !== 'string' || !password) throw new Error('The saved mailbox credential is missing. Run homepl-email-mcp setup again.');
    return password;
  }
  async function saveAccount(input, password, { signal } = {}) {
    const account = validateAccount(input);
    if (typeof password !== 'string' || !password || password.length > 4096 || password.includes('\0')) throw new Error('Enter the mailbox password.');
    return mutate(async () => {
      const accounts = await readAccounts();
      const previousPassword = await keyringCall('getPassword', account.id);
      checkCancelled(signal);
      let metadataCommitted = false;
      try {
        // A native credential write may take effect and still reject. Include
        // it in the compensation boundary, not only the JSON file replacement.
        await keyringCall('setPassword', account.id, password);
        checkCancelled(signal);
        await writeAccounts([...accounts.filter(a => a.id !== account.id), account]);
        metadataCommitted = true;
        checkCancelled(signal);
      } catch (error) {
        let recoveryFailed = false;
        if (metadataCommitted) {
          try { await writeAccounts(accounts); } catch { recoveryFailed = true; }
        }
        try {
          if (previousPassword !== null && previousPassword !== undefined) await keyringCall('setPassword', account.id, previousPassword);
          else await keyringCall('deletePassword', account.id);
        } catch { recoveryFailed = true; }
        if (recoveryFailed) throw configError('CONFIG_RECOVERY_REQUIRED');
        throw configError(Object.hasOwn(configErrorDescriptions, error?.code) ? error.code : 'CONFIG_SETTINGS_WRITE_FAILED');
      }
      return account;
    }, signal);
  }
  async function removeAccount(id) {
    validateId(id);
    return mutate(async () => {
      const accounts = await readAccounts();
      if (!accounts.some(a => a.id === id)) throw new Error('Mail account not found.');
      const previousPassword = await keyringCall('getPassword', id);
      try {
        await keyringCall('deletePassword', id);
        await writeAccounts(accounts.filter(a => a.id !== id));
      }
      catch (error) {
        try {
          if (previousPassword !== null && previousPassword !== undefined) await keyringCall('setPassword', id, previousPassword);
        } catch { throw configError('CONFIG_RECOVERY_REQUIRED'); }
        throw configError(Object.hasOwn(configErrorDescriptions, error?.code) ? error.code : 'CONFIG_SETTINGS_WRITE_FAILED');
      }
      return { removed: true, id };
    });
  }
  return { listAccounts, getAccount, getPassword, saveAccount, removeAccount, checkStorage };
}

const defaultStore = createConfigStore();
export const { listAccounts, getAccount, getPassword, saveAccount, removeAccount, checkStorage } = defaultStore;
