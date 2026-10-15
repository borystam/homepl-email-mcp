import http from 'node:http';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { ImapFlow } from 'imapflow';
import nodemailer from 'nodemailer';
import { saveAccount as persistAccount, listAccounts as readAccounts, validateAccount, configErrorDescriptions } from './config.js';

const MAX_BODY = 16 * 1024;
const VERIFY_ERROR = 'Connection could not be verified. Check the mailbox email, password, and exact server hostname. External mail-client access must be enabled in home.pl.';
const SAVE_ERROR = 'The connection worked, but the account could not be saved. Unlock your operating system credential store and check the local data directory, then retry.';

export async function verifyAccount(account, password) {
  const imap = new ImapFlow({
    host: account.imap.host, port: 993, secure: true,
    auth: { user: account.email, pass: password },
    tls: { rejectUnauthorized: true, minVersion: 'TLSv1.2' },
    logger: false, emitLogs: false, connectionTimeout: 15000,
    greetingTimeout: 15000, socketTimeout: 30000,
  });
  imap.on('error', () => {});
  const discovered = {};
  try {
    await imap.connect();
    // Special-use names avoid assuming English folder names on a Polish server.
    for (const folder of await imap.list()) {
      const key = { '\\Sent': 'sent', '\\Drafts': 'drafts', '\\Trash': 'trash' }[folder.specialUse];
      if (key) discovered[key] = folder.path;
    }
  } catch {
    throw new Error(VERIFY_ERROR);
  } finally {
    imap.close();
  }
  const smtp = nodemailer.createTransport({
    host: account.smtp.host, port: 465, secure: true,
    forceAuth: true,
    auth: { user: account.email, pass: password },
    tls: { rejectUnauthorized: true, minVersion: 'TLSv1.2' },
    logger: false, debug: false, connectionTimeout: 15000,
    greetingTimeout: 15000, socketTimeout: 30000,
  });
  try { await smtp.verify(); }
  catch { throw new Error(VERIFY_ERROR); }
  finally { smtp.close(); }
  return discovered;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function page({ csrf, path, nonce, error, connected = false }) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connect home.pl email</title><style nonce="${nonce}">
*{box-sizing:border-box}body{margin:0;padding:32px 18px;background:#f4f6f8;color:#152c3b;font:16px/1.5 system-ui,sans-serif}main{max-width:650px;margin:0 auto;background:white;padding:32px;border:1px solid #d9e2e7;border-radius:18px}h1{font-size:28px;line-height:1.2;margin:8px 0 16px}.label{font-size:13px;color:#486575;font-weight:700;text-transform:uppercase;letter-spacing:.08em}p{margin:12px 0}label{display:block;font-weight:600;margin-top:18px}input{display:block;width:100%;font:inherit;border:1px solid #99afbc;border-radius:7px;padding:10px 12px;margin-top:5px}input:focus{outline:3px solid #a5d9ff;outline-offset:1px}small{display:block;font-size:13px;color:#486575;margin-top:4px}button{border:0;border-radius:8px;background:#075e9a;color:white;padding:13px 22px;font:inherit;font-weight:600;margin-top:24px;width:100%;cursor:pointer}details{margin-top:22px}summary{cursor:pointer}.notice{padding:14px;border-radius:8px;background:#eff6fa}.error{background:#fff0ed;color:#8c2418;border:1px solid #f1b9ac;padding:12px;border-radius:8px}.success{background:#edf8f0;color:#175b31;padding:16px;border-radius:8px}footer{font-size:13px;color:#486575;margin-top:24px}
</style></head><body><main><div class="label">Company email · Local setup</div><h1>${connected ? 'Email connected' : 'Connect your home.pl mailbox'}</h1>${connected
    ? '<p class="success">Your IMAP and SMTP logins were verified. Your mailbox password is saved in this computer’s operating system credential store.</p><p>You can close this tab and return to your agent. Ask it to list your email folders to check the connection.</p>'
    : `<p>Use the email address and password you normally use for home.pl webmail.</p><p class="notice">Enter your password only here, never in chat. This page runs on your computer. Messages and attachments retrieved by the agent may be sent to its AI provider.</p>${error ? `<p role="alert" class="error">${escapeHtml(error)}</p>` : ''}
<form method="post" action="${path}" autocomplete="on"><input type="hidden" name="token" value="${csrf}"><label for="email">Mailbox email address</label><input id="email" name="email" type="email" autocomplete="username" maxlength="254" required placeholder="name@your-company.pl"><label for="password">Mailbox password</label><input id="password" name="password" type="password" autocomplete="current-password" maxlength="4096" required><label for="imapHost">Mail server hostname</label><input id="imapHost" name="imapHost" type="text" autocomplete="off" spellcheck="false" maxlength="253" required placeholder="serwer123456.home.pl"><small>Find the exact address in home.pl Panel → Poczta → your mailbox → Serwery pocztowe. Do not enter poczta.home.pl or a website URL. IMAP uses encrypted port 993.</small><details><summary>Optional settings</summary><label for="smtpHost">SMTP server, if different</label><input id="smtpHost" name="smtpHost" type="text" autocomplete="off" spellcheck="false" maxlength="253" placeholder="Same as mail server above"><small>SMTP uses encrypted port 465.</small><label for="displayName">Your sender name</label><input id="displayName" name="displayName" maxlength="200" autocomplete="name"><label for="sent">Sent folder</label><input id="sent" name="sent" maxlength="1024" placeholder="Detect automatically"><label for="drafts">Drafts folder</label><input id="drafts" name="drafts" maxlength="1024" placeholder="Detect automatically"><label for="trash">Trash folder</label><input id="trash" name="trash" maxlength="1024" placeholder="Detect automatically"></details><button type="submit">Verify and connect email</button></form><footer>Verification signs in to IMAP and SMTP without sending a message. Setup expires after 15 minutes. Your password is stored in Keychain on macOS, Credential Manager on Windows, or Secret Service on Linux.</footer>`}</main></body></html>`;
}

function equalToken(value, expected) {
  if (typeof value !== 'string') return false;
  const actual = Buffer.from(value);
  const wanted = Buffer.from(expected);
  return actual.length === wanted.length && timingSafeEqual(actual, wanted);
}

async function readForm(request) {
  if (request.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/x-www-form-urlencoded') throw new Error('Unsupported form.');
  if (Number(request.headers['content-length']) > MAX_BODY) throw new Error('Form too large.');
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY) throw new Error('Form too large.');
    chunks.push(chunk);
  }
  const form = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
  for (const key of form.keys()) if (form.getAll(key).length !== 1) throw new Error('Duplicate form field.');
  return Object.fromEntries(form);
}

/**
 * Optional verify(account,password), saveAccount(account,password,{signal}), and listAccounts()
 * callbacks allow end-to-end setup tests without contacting a real mailbox/keyring.
 * Saves must honor cancellation before commit. Completion waits for an in-flight
 * save/rollback, so closing setup never claims completion while secrets change.
 * completion resolves connected, expired, cancelled, or failed (recovery needed).
 */
export async function startSetup(options = {}) {
  const verify = options.verify || verifyAccount;
  const save = options.saveAccount || persistAccount;
  const list = options.listAccounts || readAccounts;
  const capability = randomBytes(32).toString('base64url');
  const csrf = randomBytes(32).toString('base64url');
  const path = `/setup/${capability}`;
  let busy = false;
  let finished = false;
  let saving = false;
  let closeResult;
  const cancellation = new AbortController();
  let origin;
  let authority;
  let expireTimer;
  let resolveCompletion;
  const completion = new Promise(resolve => { resolveCompletion = resolve; });

  function finish(result) {
    if (finished) return;
    finished = true;
    closeResult = result;
    clearTimeout(expireTimer);
    if (result.status !== 'connected') cancellation.abort();
    server.close();
    server.closeIdleConnections();
    if (!saving) resolveCompletion(result);
  }

  function respond(response, status, { error, connected, plain } = {}) {
    const nonce = randomBytes(18).toString('base64url');
    response.writeHead(status, {
      'Content-Type': plain ? 'text/plain; charset=utf-8' : 'text/html; charset=utf-8',
      'Content-Security-Policy': `default-src 'none'; style-src 'nonce-${nonce}'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`,
      // Native form POSTs under no-referrer send Origin: null. Keep the real
      // same-origin Origin for CSRF checks, without leaking referrers off-site.
      'Cache-Control': 'no-store', 'Pragma': 'no-cache', 'Referrer-Policy': 'same-origin',
      'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY',
      'Cross-Origin-Opener-Policy': 'same-origin', 'Connection': 'close',
    });
    response.end(plain || page({ csrf, path, nonce, error, connected }));
  }

  async function handle(request, response) {
    if (request.headers.host !== authority || !['127.0.0.1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress)) {
      respond(response, 403, { plain: 'Forbidden.' }); return;
    }
    if (finished) { respond(response, 410, { plain: 'Setup is closed.' }); return; }
    if (request.url !== path) { respond(response, 404, { plain: 'Not found.' }); return; }
    if (request.method === 'GET') { respond(response, 200); return; }
    if (request.method !== 'POST') { respond(response, 405, { plain: 'Method not allowed.' }); return; }
    if (request.headers.origin !== origin || (request.headers['sec-fetch-site'] && request.headers['sec-fetch-site'] !== 'same-origin')) {
      respond(response, 403, { plain: 'Forbidden.' }); return;
    }
    let form;
    try { form = await readForm(request); }
    catch { respond(response, 400, { plain: 'Invalid form.' }); return; }
    // Reading a slow request body yields to the expiry/cancellation timer.
    if (finished) { respond(response, 410, { plain: 'Setup is closed. Start setup again.' }); return; }
    if (!equalToken(form.token, csrf)) { respond(response, 403, { plain: 'Forbidden.' }); return; }
    if (busy) { respond(response, 409, { error: 'A connection check is already running. Wait for it to finish.' }); return; }
    busy = true;
    let account;
    let password = form.password;
    form.password = '';
    try {
      if (typeof password !== 'string' || !password || password.length > 4096 || password.includes('\0')) throw new Error('Enter the mailbox password.');
      account = validateAccount({
        id: randomUUID(), email: form.email, displayName: form.displayName,
        imap: { host: form.imapHost, port: 993 },
        smtp: { host: form.smtpHost?.trim() || form.imapHost, port: 465 },
        folders: { sent: form.sent, drafts: form.drafts, trash: form.trash },
      });
    } catch {
      busy = false; password = undefined;
      respond(response, 400, { error: 'Enter a valid email, password, and exact DNS mail server hostname without a URL or port.' }); return;
    }
    try {
      const discovered = await verify(account, password);
      if (finished) { respond(response, 410, { plain: 'Setup expired. Start setup again.' }); return; }
      account = validateAccount({ ...account, folders: { ...(discovered || {}), ...account.folders } });
    } catch {
      busy = false; password = undefined;
      respond(response, 400, { error: VERIFY_ERROR }); return;
    }
    let saved = false;
    try {
      const existing = (await list()).find(a => a.email.toLowerCase() === account.email.toLowerCase() && a.imap.host === account.imap.host);
      if (existing) account.id = existing.id;
      if (finished) { respond(response, 410, { plain: 'Setup expired. Start setup again.' }); return; }
      saving = true;
      await save(account, password, { signal: cancellation.signal });
      saved = true;
    } catch (error) {
      busy = false; password = undefined;
      if (['CONFIG_RECOVERY_REQUIRED', 'CONFIG_LOCK_RELEASE_FAILED'].includes(error.code)) {
        const message = configErrorDescriptions[error.code];
        if (finished) closeResult = { status: 'failed', message };
        respond(response, 500, { error: message }); return;
      }
      if (finished) { respond(response, 410, { plain: 'Setup is closed. Start setup again.' }); return; }
      if (error.code === 'CONFIG_BUSY') {
        respond(response, 409, { error: configErrorDescriptions.CONFIG_BUSY }); return;
      }
      respond(response, 500, { error: SAVE_ERROR }); return;
    } finally {
      password = undefined;
      saving = false;
      if (finished) {
        // A commit may finish just before cancellation reaches it. Report the
        // observed successful save rather than falsely saying it was discarded.
        resolveCompletion(saved ? { status: 'connected', account } : closeResult);
      }
    }
    respond(response, 200, { connected: true });
    // Connection outcome must not depend on the browser receiving the response.
    finish({ status: 'connected', account });
  }

  const server = http.createServer((request, response) => {
    handle(request, response).catch(() => {
      busy = false;
      if (!response.headersSent) respond(response, 500, { plain: 'Setup failed. Please try again.' });
      else response.end();
    });
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 10000;
  server.keepAliveTimeout = 1000;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
  });
  authority = `127.0.0.1:${server.address().port}`;
  origin = `http://${authority}`;
  const timeoutMs = Math.max(1, Math.min(options.timeoutMs ?? 15 * 60 * 1000, 15 * 60 * 1000));
  expireTimer = setTimeout(() => finish({ status: 'expired' }), timeoutMs);
  return { url: `${origin}${path}`, close: () => finish({ status: 'cancelled' }), completion };
}
