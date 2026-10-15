import { userInfo } from 'node:os';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import { dataDir, configErrorDescriptions } from './config.js';
import { tlsErrorDescriptions } from './tls.js';
import { startSetup as startLocalSetup } from './setup.js';

const { version: connectorVersion } = createRequire(import.meta.url)('../package.json');

export const onboardingErrorDescriptions = Object.freeze({
  SETUP_REQUIRES_DESKTOP_USER: 'This MCP process runs as a Codex sandbox account. The installing agent must check the desktop app’s local MCP entry: launch the native Node executable and connector directly, reload, and check mail_setup_status again. If it still reports a sandbox account, report the client launch block. Do not enter a mailbox password or change Windows security policy in this context.',
  SETUP_IDENTITY_UNAVAILABLE: 'The MCP process could not identify its operating-system user. Check the desktop app’s native MCP launch context before entering mailbox credentials.',
  SETUP_START_FAILED: 'The private local setup page could not be started. Check the native MCP process and its local storage access, then retry.',
  SETUP_FAILED: 'Setup did not finish successfully. Check the private form and local storage status before retrying; no credential details are returned in chat.',
});

const errorDescriptions = Object.freeze({ ...configErrorDescriptions, ...tlsErrorDescriptions, ...onboardingErrorDescriptions });
const defaultIdentity = () => ({ platform: process.platform, username: userInfo().username, node: process.version, dataDir: resolve(dataDir()) });

function identity(getIdentity) {
  const value = getIdentity();
  const fields = ['platform', 'username', 'node', 'dataDir'];
  if (!value || !fields.every(key => typeof value[key] === 'string' && value[key].length > 0)) throw new Error();
  // Only these local execution facts are useful; never return an environment dump.
  return Object.fromEntries(fields.map(key => [key, value[key]]));
}

function privateSetupUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password || url.search || url.hash || !/^\/setup\/[A-Za-z0-9_-]+$/.test(url.pathname)) throw new Error();
  return url.href;
}

/**
 * Own a single wizard inside the actual MCP host process, rather than the
 * agent's potentially different shell identity. The wizard itself probes native
 * credential access before opening; a username alone cannot prove it works.
 * Injected dependencies are for isolated tests, never mail/tool arguments.
 */
export function createOnboarding({ startSetup = startLocalSetup, getIdentity = defaultIdentity } = {}) {
  let execution;
  let identityFailed = false;
  try { execution = identity(getIdentity); } catch { identityFailed = true; }
  let state = { status: 'idle', ...(execution ? { execution } : {}) };
  let active;
  let starting;
  let closed = false;
  let generation = 0;

  const status = () => ({ ...structuredClone(state), connectorVersion });
  function blocked(error) {
    const code = typeof error?.code === 'string' && Object.hasOwn(errorDescriptions, error.code) ? error.code : 'SETUP_START_FAILED';
    return { status: 'blocked', error: code, message: errorDescriptions[code], ...(execution ? { execution } : {}) };
  }
  function complete(result) {
    if (result?.status === 'connected' && typeof result.account?.id === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(result.account.id)) {
      return { status: 'connected', accountId: result.account.id, execution, instructions: 'The mailbox was saved in this MCP process’s operating-system credential store. Use mail_accounts and mail_folders to verify the connection.' };
    }
    if (result?.status === 'expired' || result?.status === 'cancelled') return { status: result.status, execution };
    return { status: 'failed', error: 'SETUP_FAILED', message: onboardingErrorDescriptions.SETUP_FAILED, execution };
  }

  function start() {
    if (closed) return Promise.resolve(status());
    if (starting) return starting;
    if (active) return Promise.resolve(status());
    const attempt = ++generation;
    state = { status: 'starting', ...(execution ? { execution } : {}) };
    const pending = (async () => {
      if (identityFailed) {
        state = blocked({ code: 'SETUP_IDENTITY_UNAVAILABLE' });
        return status();
      }
      if (execution.platform === 'win32' && /^codexsandbox/i.test(execution.username)) {
        state = blocked({ code: 'SETUP_REQUIRES_DESKTOP_USER' });
        return status();
      }
      try {
        const wizard = await startSetup();
        if (closed || attempt !== generation) {
          wizard.close();
          await wizard.completion;
          return status();
        }
        let url;
        try { url = privateSetupUrl(wizard.url); }
        catch {
          wizard.close();
          await wizard.completion;
          throw new Error();
        }
        active = wizard;
        state = {
          status: 'pending', url, execution,
          instructions: 'Open this private local URL in the app or browser. The employee enters and submits mailbox credentials there, never in chat or tool arguments. Do not inspect or screenshot the form after credentials are entered. Use mail_setup_status to check completion. The page expires after 15 minutes.',
        };
        Promise.resolve(wizard.completion).then(result => {
          if (active !== wizard) return;
          active = undefined;
          // Terminal state deliberately retains no setup URL or raw failure text.
          state = complete(result);
        }, () => {
          if (active !== wizard) return;
          active = undefined;
          state = complete({ status: 'failed' });
        });
        return status();
      } catch (error) {
        if (!closed && attempt === generation) state = blocked(error);
        return status();
      }
    })();
    starting = pending;
    pending.then(() => { if (starting === pending) starting = undefined; }, () => { if (starting === pending) starting = undefined; });
    return pending;
  }

  async function close() {
    closed = true;
    generation++;
    const wizard = active;
    active = undefined;
    state = { status: 'cancelled', ...(execution ? { execution } : {}) };
    if (wizard) {
      wizard.close();
      await Promise.resolve(wizard.completion).catch(() => {});
    }
    // A storage probe may still be starting the wizard. Its generation check
    // closes a late result, so disconnect cannot leak a listening HTTP server.
    if (starting) await starting;
    return status();
  }

  return { start, status, close };
}
