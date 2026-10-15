import { mkdir, open, realpath, stat, unlink } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { resolve, join, basename, sep } from 'node:path';
import { Transform, Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { ImapFlow } from 'imapflow';
import nodemailer from 'nodemailer';
import * as config from './config.js';

export class MailError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

export function jsonSafe(value) {
  return JSON.parse(JSON.stringify(value, (_key, v) => {
    if (typeof v === 'bigint') return String(v);
    if (v instanceof Set) return [...v];
    if (v instanceof Map) return [...v.entries()];
    return v;
  }));
}

export async function createContext(options = {}) {
  const dataDir = resolve(options.dataDir ?? config.dataDir());
  const downloadDir = join(dataDir, 'downloads');
  const uploadDir = join(dataDir, 'uploads');
  for (const dir of [dataDir, downloadDir, uploadDir]) await mkdir(dir, { recursive: true, mode: 0o700 });
  const getAccount = options.getAccount ?? config.getAccount;
  const getPassword = options.getPassword ?? config.getPassword;
  const imapFactory = options.imapFactory ?? (settings => new ImapFlow(settings));
  const smtpFactory = options.smtpFactory ?? (settings => nodemailer.createTransport(settings));

  async function withImap(accountId, folder, settings, fn) {
    const account = await getAccount(accountId);
    const password = await getPassword(accountId);
    const client = imapFactory({
      host: account.imap.host, port: account.imap.port, secure: true,
      auth: { user: account.email, pass: password },
      logger: false, logRaw: false, disableAutoIdle: true,
      connectionTimeout: 20000, greetingTimeout: 15000, socketTimeout: 120000,
      tls: { rejectUnauthorized: true },
    });
    // Prevent background socket errors from terminating the stdio process.
    client.on?.('error', () => {});
    let lock;
    try {
      await client.connect();
      if (folder !== null && folder !== undefined) {
        lock = await client.getMailboxLock(folder, { readOnly: !settings?.write });
        if (settings?.uidValidity !== undefined && String(client.mailbox.uidValidity) !== String(settings.uidValidity)) {
          throw new MailError('UIDVALIDITY_CHANGED', 'This folder was recreated or restored. List or search it again before using message identifiers.');
        }
      }
      return await fn(client, account);
    } finally {
      lock?.release();
      try { await client.logout(); } catch { client.close(); }
    }
  }

  async function withSmtp(accountId, fn) {
    const account = await getAccount(accountId);
    const password = await getPassword(accountId);
    const transport = smtpFactory({
      host: account.smtp.host, port: account.smtp.port, secure: true,
      auth: { user: account.email, pass: password },
      tls: { rejectUnauthorized: true },
      connectionTimeout: 20000, greetingTimeout: 15000, socketTimeout: 120000,
      logger: false, debug: false, forceAuth: true, disableFileAccess: true, disableUrlAccess: true,
    });
    try { return await fn(transport, account); } finally { transport.close(); }
  }

  async function saveStream(stream, filename = 'message.bin') {
    // Many filesystems cap each filename at 255 bytes, not 255 JS characters.
    let safeName = basename(String(filename)).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '') || 'message.bin';
    const suffix = [];
    let nameBytes = 0;
    for (const point of [...safeName].reverse()) {
      nameBytes += Buffer.byteLength(point);
      if (nameBytes > 200) break;
      suffix.push(point);
    }
    safeName = suffix.reverse().join('');
    const target = join(downloadDir, `${randomUUID()}-${safeName}`);
    const handle = await open(target, 'wx', 0o600);
    let bytes = 0;
    const hash = createHash('sha256');
    const meter = new Transform({ transform(chunk, _enc, callback) {
      bytes += chunk.length; hash.update(chunk); callback(null, chunk);
    } });
    try {
      await pipeline(stream, meter, handle.createWriteStream());
      return { path: target, bytes, sha256: hash.digest('hex') };
    } catch (error) {
      await handle.close().catch(() => {});
      await unlink(target).catch(() => {});
      throw error;
    }
  }

  async function readUpload(relativePath) {
    if (typeof relativePath !== 'string' || relativePath.length === 0 || relativePath.includes('\0')) {
      throw new MailError('INVALID_ATTACHMENT_PATH', 'Provide the attachment path relative to the uploads directory.');
    }
    const root = await realpath(uploadDir);
    const requested = resolve(root, relativePath);
    const target = await realpath(requested);
    if (!target.startsWith(root + sep) || !(await stat(target)).isFile()) {
      throw new MailError('INVALID_ATTACHMENT_PATH', 'Attachments must be regular files inside the uploads directory.');
    }
    return target;
  }

  return {
    dataDir, downloadDir, uploadDir, getAccount, withImap, withSmtp, saveStream, readUpload,
    saveBuffer: (buffer, name) => saveStream(Readable.from([buffer]), name),
  };
}
