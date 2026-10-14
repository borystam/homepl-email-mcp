import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { simpleParser } from 'mailparser';
import MailComposer from 'nodemailer/lib/mail-composer/index.js';
import { writeTools, writeErrorDescriptions, stripBccHeader } from '../src/write-tools.js';
import { createContext } from '../src/context.js';

async function fixture(t, overrides = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'home-mail-write-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const uploads = path.join(dataDir, 'uploads'); await fs.mkdir(uploads);
  const config = { id: 'a', email: 'sender@example.test', folders: { sent: 'Wysłane', drafts: 'Szkice', trash: 'Kosz' } };
  const sent = [], appended = [], calls = [];
  const client = {
    capabilities: new Set(['UIDPLUS', 'MOVE']),
    append: async (folder, raw, flags) => { appended.push({ folder, raw, flags }); return { uid: 89, uidValidity: 7n }; },
    fetchOne: async (...args) => { calls.push(['fetchOne', ...args]); return { uid: 501 }; },
    messageDelete: async (...args) => { calls.push(['delete', ...args]); return true; },
    messageMove: async (...args) => { calls.push(['move', ...args]); return { uidValidity: 9n, uidMap: new Map([[501, 90]]) }; },
    messageFlagsAdd: async (...args) => { calls.push(['flags', ...args]); return true; },
    ...overrides.client,
  };
  const ctx = {
    dataDir, getAccount: async () => config,
    readUpload: async relative => { const resolved = path.resolve(uploads, relative); if (!resolved.startsWith(uploads + path.sep)) throw new Error('outside uploads'); return fs.realpath(resolved); },
    withImap: async (id, folder, options, fn) => { calls.push(['imap', id, folder, options]); return fn(client, config); },
    withSmtp: async (id, fn) => fn({ sendMail: async args => {
      sent.push(args);
      const op = (await fs.readdir(path.join(dataDir, 'outbox')))[0];
      const state = JSON.parse(await fs.readFile(path.join(dataDir, 'outbox', op, 'state.json')));
      assert.equal(state.status, 'sending', 'durable state must precede any SMTP action');
      if (overrides.sendMail) return overrides.sendMail(args);
      return { accepted: args.envelope.to, rejected: [], messageId: 'smtp-id' };
    } }),
  };
  const tools = Object.fromEntries(writeTools(ctx).map(tool => [tool.name, async args => tool.handler(tool.schema.parse(args))]));
  return { tools, ctx, uploads, sent, appended, calls, client };
}

const basic = { accountId: 'a', to: ['customer@example.test'], subject: 'Zażółć gęślą jaźń', text: 'Test body' };

test('multiline text and HTML drafts satisfy strict IMAP CRLF requirements', async t => {
  const appended = [];
  const f = await fixture(t, { client: { append: async (folder, raw) => {
    // Cyrus and other strict servers reject APPEND literals with bare LF.
    assert.doesNotMatch(raw.toString('latin1'), /(?<!\r)\n/, 'APPEND contains a bare LF');
    appended.push(raw);
    return { uid: 89, uidValidity: 7n };
  } } });
  for (const body of [
    { text: 'first\nsecond\r\nthird' },
    { text: undefined, html: '<p>first</p>\n<p>second</p>\r\n<p>third</p>' },
    { text: 'first\nsecond', html: '<p>first</p>\n<p>second</p>' },
  ]) {
    await f.tools.mail_save_draft({ ...basic, ...body });
    const parsed = await simpleParser(appended.at(-1));
    if (body.text) assert.equal(parsed.text.trimEnd(), body.text.replace(/\r\n/g, '\n'));
    if (body.html) assert.equal(parsed.html.trimEnd().replace(/\r\n/g, '\n'), body.html.replace(/\r\n/g, '\n'));
  }
  assert.equal(f.sent.length, 0);
});

test('prepared and Sent MIME use CRLF while preserving binary attachment bytes', async t => {
  const f = await fixture(t);
  const bytes = Buffer.from([0, 10, 13, 10, 13, 255, 128]);
  await fs.writeFile(path.join(f.uploads, 'linebreaks.bin'), bytes);
  const prepared = await f.tools.mail_prepare({ ...basic, text: 'first\nsecond\r\nthird',
    html: '<p>first</p>\n<p>second</p>', bcc: ['private@example.test'],
    attachments: [{ relativePath: 'linebreaks.bin' }] });
  for (const filename of [prepared.emlPath, prepared.sentEmlPath]) {
    const raw = await fs.readFile(filename);
    assert.doesNotMatch(raw.toString('latin1'), /(?<!\r)\n/);
    assert.deepEqual((await simpleParser(raw)).attachments[0].content, bytes);
  }
  const result = await f.tools.mail_send_prepared({ accountId: 'a', operationId: prepared.operationId });
  assert.equal(result.sentCopy.saved, true);
  assert.deepEqual(f.appended[0].raw, await fs.readFile(prepared.sentEmlPath));
  assert.deepEqual(f.sent[0].raw, stripBccHeader(f.appended[0].raw));
});

test('prepared bytes retain Bcc only in Sent and differ from wire solely by that header', async t => {
  const f = await fixture(t);
  const bytes = Buffer.from([0, 255, 128, 1, 13, 10]);
  await fs.writeFile(path.join(f.uploads, 'sample.bin'), bytes);
  const prepared = await f.tools.mail_prepare({ ...basic, bcc: ['private@example.test'], attachments: [{ relativePath: 'sample.bin' }] });
  const raw = await fs.readFile(prepared.emlPath);
  const parsed = await simpleParser(raw);
  assert.equal(parsed.subject, basic.subject);
  assert.equal(parsed.bcc, undefined);
  assert.deepEqual(parsed.attachments[0].content, bytes);
  // Later modifications of uploads cannot change the approved send.
  await fs.writeFile(path.join(f.uploads, 'sample.bin'), 'changed');
  const result = await f.tools.mail_send_prepared({ accountId: 'a', operationId: prepared.operationId });
  assert.equal(result.smtpAccepted, true); assert.equal(result.sentCopy.saved, true);
  assert.deepEqual(f.sent[0].raw, raw);
  assert.deepEqual(f.appended[0].raw, await fs.readFile(prepared.sentEmlPath));
  const saved = await simpleParser(f.appended[0].raw);
  assert.equal(saved.bcc.value[0].address, 'private@example.test');
  assert.equal(saved.messageId, parsed.messageId);
  assert.equal(saved.date.toISOString(), parsed.date.toISOString());
  assert.deepEqual(saved.attachments[0].content, bytes);
  const withoutBcc = Buffer.from(f.appended[0].raw.toString('latin1').replace(/^Bcc:[^\r\n]*(?:\r\n[ \t][^\r\n]*)*\r\n/gmi, ''), 'latin1');
  assert.deepEqual(withoutBcc, raw);
  assert.deepEqual(f.sent[0].envelope.to, ['customer@example.test', 'private@example.test']);
  assert.equal(f.appended[0].folder, 'Wysłane');
  const repeated = await f.tools.mail_send_prepared({ accountId: 'a', operationId: prepared.operationId });
  assert.equal(repeated.retryAllowed, false); assert.equal(f.sent.length, 1);
});

test('SMTP acceptance plus Sent-copy failure is explicit and cannot trigger duplicate send', async t => {
  const f = await fixture(t, { client: { append: async () => { throw new Error('connection lost'); } } });
  const p = await f.tools.mail_prepare(basic);
  const result = await f.tools.mail_send_prepared({ accountId: 'a', operationId: p.operationId });
  assert.equal(result.smtpAccepted, true); assert.equal(result.sentCopy.saved, false);
  await f.tools.mail_send_prepared({ accountId: 'a', operationId: p.operationId });
  assert.equal(f.sent.length, 1);
});

test('ambiguous SMTP failure is persisted unknown and retry never resends', async t => {
  const f = await fixture(t, { sendMail: async () => { throw new Error('connection lost after DATA'); } });
  const p = await f.tools.mail_prepare(basic);
  const result = await f.tools.mail_send_prepared({ accountId: 'a', operationId: p.operationId });
  assert.equal(result.status, 'unknown'); assert.equal(result.smtpAccepted, null);
  const again = await f.tools.mail_send_prepared({ accountId: 'a', operationId: p.operationId });
  assert.equal(again.status, 'unknown'); assert.equal(f.sent.length, 1);
});

test('outbox operation is bound to account and byte integrity', async t => {
  const f = await fixture(t);
  const p = await f.tools.mail_prepare(basic);
  await assert.rejects(f.tools.mail_send_prepared({ accountId: 'other', operationId: p.operationId }), /does not belong/);
  await fs.appendFile(p.emlPath, 'corruption');
  await assert.rejects(f.tools.mail_send_prepared({ accountId: 'a', operationId: p.operationId }), /integrity/);
  assert.equal(f.sent.length, 0);
  await assert.rejects(f.tools.mail_prepare({ ...basic, attachments: [{ relativePath: '../secrets' }] }), /outside/);
});

test('Sent MIME integrity is checked before any SMTP action', async t => {
  const f = await fixture(t);
  const p = await f.tools.mail_prepare({ ...basic, bcc: ['private@example.test'] });
  await fs.appendFile(p.sentEmlPath, 'corruption');
  await assert.rejects(f.tools.mail_send_prepared({ accountId: 'a', operationId: p.operationId }), error => error.code === 'OUTBOX_INTEGRITY_FAILED');
  assert.equal(f.sent.length, 0);
});

test('Bcc stripping removes repeated folded fields and leaves body bytes untouched', () => {
  const body = Buffer.from([66, 99, 99, 58, 32, 1, 255, 13, 10]);
  const head = 'From: sender@example.test\r\nBcc: one@example.test,\r\n two@example.test\r\nSubject: Kept\r\nbCc: three@example.test\r\n\t, four@example.test\r\nMessage-ID: <keep@example.test>\r\n\r\n';
  const expected = Buffer.concat([Buffer.from('From: sender@example.test\r\nSubject: Kept\r\nMessage-ID: <keep@example.test>\r\n\r\n'), body]);
  assert.deepEqual(stripBccHeader(Buffer.concat([Buffer.from(head), body])), expected);
});

test('delete and move refuse unsafe global expunge, and permanent delete uses UID mode', async t => {
  const f = await fixture(t);
  const args = { accountId: 'a', folder: 'INBOX', uid: 501, uidValidity: '7' };
  f.client.capabilities.clear();
  await assert.rejects(f.tools.mail_delete_permanently(args), /UIDPLUS/);
  await assert.rejects(f.tools.mail_move({ ...args, action: 'trash' }), /MOVE or UIDPLUS/);
  assert.equal(f.calls.some(c => c[0] === 'delete'), false);
  f.client.capabilities.add('UIDPLUS');
  await f.tools.mail_delete_permanently(args);
  assert.deepEqual(f.calls.find(c => c[0] === 'delete'), ['delete', '501', { uid: true }]);
  assert.deepEqual(f.calls.find(c => c[0] === 'imap').slice(1), ['a', 'INBOX', { write: true, uidValidity: '7' }]);
});

test('reply-all uses Reply-To, excludes own address, preserves threading, and fetches UID not sequence', async t => {
  const raw = Buffer.from('From: Original <original@example.test>\r\nReply-To: replies@example.test\r\nTo: sender@example.test, teammate@example.test\r\nCc: observer@example.test\r\nSubject: Existing\r\nMessage-ID: <root@example.test>\r\nReferences: <prior@example.test>\r\n\r\nOriginal body\r\n');
  const f = await fixture(t, { client: { fetchOne: async (uid, query, options) => { assert.equal(uid, '501'); assert.deepEqual(options, { uid: true }); return { source: raw }; } } });
  const p = await f.tools.mail_prepare({ accountId: 'a', kind: 'reply_all', folder: 'INBOX', uid: 501, uidValidity: '7', text: 'Reply' });
  const parsed = await simpleParser(await fs.readFile(p.emlPath));
  assert.equal(parsed.to.value[0].address, 'replies@example.test');
  assert.deepEqual(parsed.cc.value.map(a => a.address), ['teammate@example.test', 'observer@example.test']);
  assert.equal(parsed.inReplyTo, '<root@example.test>');
  assert.deepEqual(parsed.references, ['<prior@example.test>', '<root@example.test>']);
});

test('forward preserves attachment bytes and draft keeps Bcc without sending', async t => {
  const binary = Buffer.from([3, 17, 221, 0]);
  const raw = await new MailComposer({ from: 'source@example.test', to: 'sender@example.test', subject: 'Original', text: 'Old', attachments: [{ filename: 'binary.bin', content: binary }] }).compile().build();
  const f = await fixture(t, { client: { fetchOne: async () => ({ source: raw }) } });
  const p = await f.tools.mail_prepare({ ...basic, kind: 'forward', folder: 'INBOX', uid: 501, uidValidity: '7' });
  const parsed = await simpleParser(await fs.readFile(p.emlPath));
  assert.deepEqual(parsed.attachments[0].content, binary);
  assert.match(parsed.text, /Old/);
  const draft = await f.tools.mail_save_draft({ ...basic, bcc: ['hidden@example.test'] });
  assert.equal(draft.uidValidity, '7'); assert.equal(f.sent.length, 0);
  assert.equal((await simpleParser(f.appended[0].raw)).bcc.value[0].address, 'hidden@example.test');
});

test('concurrent attempts cannot send the same prepared operation twice', async t => {
  const f = await fixture(t);
  const p = await f.tools.mail_prepare(basic);
  const args = { accountId: 'a', operationId: p.operationId };
  const results = await Promise.allSettled([f.tools.mail_send_prepared(args), f.tools.mail_send_prepared(args)]);
  assert.equal(f.sent.length, 1);
  assert.equal(results.some(r => r.status === 'fulfilled' && r.value.smtpAccepted), true);
});

test('draft update preserves attachments, replaces both body formats, and deletes only after confirmed append', async t => {
  const binary = Buffer.from([0, 199, 14]);
  const compiled = new MailComposer({ from: 'sender@example.test', to: 'customer@example.test', bcc: 'private@example.test', subject: 'Draft', text: 'Old text', html: '<b>Old HTML</b>', inReplyTo: '<original@example.test>', attachments: [{ filename: 'kept.bin', content: binary }] }).compile();
  compiled.keepBcc = true;
  const raw = await compiled.build();
  const f = await fixture(t, { client: { fetchOne: async (uid, query, options) => {
    assert.equal(uid, '501'); assert.deepEqual(options, { uid: true });
    return query.source ? { source: raw } : { flags: new Set(['\\Draft']) };
  } } });
  const args = { accountId: 'a', folder: 'Szkice', uid: 501, uidValidity: '7', text: 'New body' };
  const events = [];
  const append = f.client.append;
  f.client.append = async (...values) => { events.push('append'); return append(...values); };
  f.client.messageDelete = async (uid, options) => { events.push('delete'); assert.equal(uid, '501'); assert.deepEqual(options, { uid: true }); return true; };
  const result = await f.tools.mail_update_draft(args);
  assert.deepEqual(events, ['append', 'delete']);
  assert.equal(result.uid, 89); assert.equal(result.previousDraftRetained, false);
  const parsed = await simpleParser(f.appended[0].raw);
  assert.match(parsed.text, /New body/); assert.equal(parsed.html, false);
  assert.deepEqual(parsed.attachments[0].content, binary);
  assert.equal(parsed.inReplyTo, '<original@example.test>');
  assert.equal(parsed.bcc.value[0].address, 'private@example.test');
  assert.equal(f.sent.length, 0);

  events.length = 0;
  f.client.append = async () => { events.push('append-failed'); return false; };
  await assert.rejects(f.tools.mail_update_draft(args), error => error.code === 'DRAFT_SAVE_FAILED');
  assert.deepEqual(events, ['append-failed']);

  events.length = 0;
  f.client.capabilities.clear();
  await assert.rejects(f.tools.mail_update_draft(args), error => error.code === 'DRAFT_UPDATE_UNSAFE');
  assert.deepEqual(events, []);
});

test('draft update reports partial success and missing append UID without risking old draft', async t => {
  const raw = await new MailComposer({ from: 'sender@example.test', to: 'customer@example.test', text: 'Old' }).compile().build();
  const f = await fixture(t, { client: { fetchOne: async (_uid, query) => query.source ? { source: raw } : { flags: new Set(['\\Draft']) } } });
  const args = { accountId: 'a', folder: 'Szkice', uid: 501, uidValidity: '7', text: 'Updated' };
  f.client.messageDelete = async () => { throw new Error('provider response containing PRIVATE DATA'); };
  const partial = await f.tools.mail_update_draft(args);
  assert.equal(partial.saved, true); assert.equal(partial.previousDraftRetained, null);
  assert.doesNotMatch(JSON.stringify(partial), /PRIVATE DATA/);
  f.client.append = async () => ({});
  f.client.messageDelete = async () => assert.fail('cannot delete without returned new UID');
  const missing = await f.tools.mail_update_draft(args);
  assert.equal(missing.saved, true); assert.equal(missing.previousDraftRetained, true);
  assert.equal(missing.uid, null);
});

test('safe write errors expose only fixed actionable descriptions', async t => {
  const f = await fixture(t);
  await assert.rejects(f.tools.mail_prepare({ accountId: 'a', text: 'hello' }), error => {
    assert.equal(error.code, 'RECIPIENT_REQUIRED');
    assert.equal(error.message, writeErrorDescriptions.RECIPIENT_REQUIRED);
    return true;
  });
});

test('draft and reply-all preserve every recipient inside RFC address groups', async t => {
  const raw = Buffer.from('From: customer@example.test\r\nTo: Team: first@example.test, second@example.test;\r\nCc: Other: third@example.test;\r\nBcc: Private: hidden@example.test;\r\nSubject: Group recipients\r\n\r\nBody\r\n');
  const f = await fixture(t, { client: { fetchOne: async () => ({ source: raw }) } });
  const id = { accountId: 'a', folder: 'Drafts', uid: 501, uidValidity: '7' };
  const draft = await f.tools.mail_prepare_draft(id);
  assert.deepEqual(draft.preview.to, ['first@example.test', 'second@example.test']);
  assert.deepEqual(draft.preview.cc, ['third@example.test']);
  assert.deepEqual(draft.preview.bcc, ['hidden@example.test']);
  const reply = await f.tools.mail_prepare({ ...id, kind: 'reply_all', text: 'Reply' });
  assert.deepEqual(reply.preview.to, ['customer@example.test']);
  assert.deepEqual(reply.preview.cc, ['first@example.test', 'second@example.test', 'third@example.test']);
  assert.deepEqual(reply.preview.bcc, [], 'reply-all must never expose original Bcc recipients');
});

test('incomplete server drafts can be saved, but cannot be prepared for sending without recipients', async t => {
  const f = await fixture(t);
  const result = await f.tools.mail_save_draft({ accountId: 'a', subject: 'Work in progress' });
  assert.equal(result.saved, true); assert.equal(f.sent.length, 0);
  const parsed = await simpleParser(f.appended[0].raw);
  assert.equal(parsed.subject, 'Work in progress');
  assert.equal(parsed.to, undefined);
  f.client.fetchOne = async (_uid, query) => query.source ? { source: f.appended[0].raw } : { flags: new Set(['\\Draft']) };
  const id = { accountId: 'a', folder: 'Drafts', uid: 501, uidValidity: '7' };
  const update = await f.tools.mail_update_draft({ ...id, text: 'Still drafting' });
  assert.equal(update.saved, true);
  await assert.rejects(f.tools.mail_prepare_draft(id), error => error.code === 'RECIPIENT_REQUIRED');
});

test('forward and updated draft retain inline CID references and exact embedded image bytes', async t => {
  const image = Buffer.from([137, 80, 78, 71, 0, 255, 16]);
  const raw = await new MailComposer({ from: 'source@example.test', to: 'sender@example.test', html: '<p>Picture <img src="cid:picture@example.test"></p>', attachments: [{ filename: 'image.png', content: image, contentType: 'image/png', cid: 'picture@example.test' }] }).compile().build();
  const f = await fixture(t, { client: { fetchOne: async (_uid, query) => query.source ? { source: raw } : { flags: new Set(['\\Draft']) } } });
  const id = { accountId: 'a', folder: 'Drafts', uid: 501, uidValidity: '7' };
  const forward = await f.tools.mail_prepare({ ...basic, ...id, kind: 'forward' });
  const parsed = await simpleParser(await fs.readFile(forward.emlPath), { keepCidLinks: true });
  assert.match(parsed.html, /src="cid:picture@example.test"/);
  assert.deepEqual(parsed.attachments[0].content, image);
  assert.equal(parsed.attachments[0].contentId, '<picture@example.test>');
  await f.tools.mail_update_draft({ ...id, subject: 'Changed subject' });
  const updated = await simpleParser(f.appended[0].raw, { keepCidLinks: true });
  assert.match(updated.html, /src="cid:picture@example.test"/);
  assert.deepEqual(updated.attachments[0].content, image);
});

test('partial SMTP acceptance reports rejected recipients and never retries accepted recipients', async t => {
  const f = await fixture(t, { sendMail: async () => ({ accepted: ['customer@example.test'], rejected: ['invalid@example.test'], messageId: 'partial' }) });
  const p = await f.tools.mail_prepare({ ...basic, cc: ['invalid@example.test'] });
  const args = { accountId: 'a', operationId: p.operationId };
  const result = await f.tools.mail_send_prepared(args);
  assert.equal(result.smtpAccepted, true);
  assert.deepEqual(result.accepted, ['customer@example.test']);
  assert.deepEqual(result.rejected, ['invalid@example.test']);
  const status = await f.tools.mail_outbox_status(args);
  assert.deepEqual(status.outcome.rejected, ['invalid@example.test']);
  await f.tools.mail_send_prepared(args);
  assert.equal(f.sent.length, 1); assert.equal(f.appended.length, 1);
});

test('definitive all-recipient rejection is distinguished from unknown delivery and cannot retry', async t => {
  const f = await fixture(t, { sendMail: async () => { throw Object.assign(new Error('PRIVATE SMTP RESPONSE'), { code: 'EENVELOPE', command: 'RCPT TO', responseCode: 550, rejected: ['customer@example.test'] }); } });
  const p = await f.tools.mail_prepare(basic);
  const args = { accountId: 'a', operationId: p.operationId };
  const result = await f.tools.mail_send_prepared(args);
  assert.equal(result.status, 'rejected'); assert.equal(result.smtpAccepted, false);
  assert.deepEqual(result.rejected, ['customer@example.test']);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE/);
  const again = await f.tools.mail_send_prepared(args);
  assert.equal(again.status, 'rejected'); assert.equal(f.sent.length, 1); assert.equal(f.appended.length, 0);
});

test('crash state and stale process lock both refuse SMTP on a fresh server instance', async t => {
  const f = await fixture(t);
  const p = await f.tools.mail_prepare(basic);
  const dir = path.dirname(p.emlPath);
  const statePath = path.join(dir, 'state.json');
  const state = JSON.parse(await fs.readFile(statePath));
  state.status = 'sending';
  await fs.writeFile(statePath, JSON.stringify(state));
  const restarted = Object.fromEntries(writeTools(f.ctx).map(tool => [tool.name, args => tool.handler(tool.schema.parse(args))]));
  const args = { accountId: 'a', operationId: p.operationId };
  assert.equal((await restarted.mail_send_prepared(args)).retryAllowed, false);
  await fs.writeFile(path.join(dir, 'send.lock'), '');
  await assert.rejects(restarted.mail_send_prepared(args), error => error.code === 'SEND_LOCKED');
  assert.equal(f.sent.length, 0);
});

test('safe copy works without MOVE/UIDPLUS and exact UID mutations reject stale UIDVALIDITY', async t => {
  const f = await fixture(t);
  const args = { accountId: 'a', folder: 'INBOX', uid: 501, uidValidity: '7' };
  f.client.capabilities.clear();
  f.client.messageCopy = async (uid, destination, options) => { assert.equal(uid, '501'); assert.equal(destination, 'Archive'); assert.deepEqual(options, { uid: true }); return { uidMap: new Map([[501, 4]]), uidValidity: 8n }; };
  const copied = await f.tools.mail_move({ ...args, action: 'copy', destination: 'Archive' });
  assert.deepEqual(copied.uidMap, { 501: 4 });
  f.ctx.withImap = async (_id, _folder, options) => { assert.equal(options.uidValidity, '7'); throw Object.assign(new Error('stale'), { code: 'UIDVALIDITY_CHANGED' }); };
  for (const [name, extra] of [['mail_set_flags', { add: ['\\Seen'] }], ['mail_move', { action: 'trash' }], ['mail_delete_permanently', {}]]) {
    await assert.rejects(f.tools[name]({ ...args, ...extra }), error => error.code === 'UIDVALIDITY_CHANGED');
  }
  assert.equal(f.calls.some(call => ['delete', 'flags', 'move'].includes(call[0])), false);
});

test('attachment replaced with a symlink after validation cannot read outside the approved directory', async t => {
  const f = await fixture(t);
  const approved = path.join(f.uploads, 'quote.txt');
  const outside = path.join(f.ctx.dataDir, 'secret.txt');
  await fs.writeFile(approved, 'approved'); await fs.writeFile(outside, 'PRIVATE KEY DATA');
  f.ctx.readUpload = async () => {
    // Simulate replacement immediately after the context finished validation.
    await fs.unlink(approved); await fs.symlink(outside, approved);
    return approved;
  };
  await assert.rejects(f.tools.mail_prepare({ ...basic, attachments: [{ relativePath: 'quote.txt' }] }), error => error.code === 'ATTACHMENT_FILE_CHANGED');
  assert.equal(f.sent.length, 0);
});

test('real upload validation rejects a parent directory swapped to an outside symlink before attachment reading', async t => {
  const f = await fixture(t);
  const nested = path.join(f.uploads, 'nested');
  const outside = path.join(f.ctx.dataDir, 'outside');
  await fs.mkdir(nested); await fs.mkdir(outside);
  await fs.writeFile(path.join(nested, 'quote.txt'), 'approved quote');
  await fs.writeFile(path.join(outside, 'quote.txt'), 'PRIVATE OUTSIDE DATA');
  const ctx = await createContext({ dataDir: f.ctx.dataDir, getAccount: async () => ({ email: 'sender@example.test' }), getPassword: async () => assert.fail('No mailbox login should occur') });
  const validate = ctx.readUpload;
  ctx.readUpload = async relative => {
    const validated = await validate(relative);
    await fs.rename(nested, `${nested}-before-swap`);
    await fs.symlink(outside, nested);
    return validated;
  };
  const prepare = writeTools(ctx).find(tool => tool.name === 'mail_prepare');
  await assert.rejects(prepare.handler(prepare.schema.parse({ ...basic, attachments: [{ relativePath: 'nested/quote.txt' }] })), error => error.code === 'ATTACHMENT_FILE_CHANGED');
  await assert.rejects(fs.access(path.join(f.ctx.dataDir, 'outbox')), { code: 'ENOENT' });
});

test('malformed MIME stripping and user header-injection inputs fail without side effects', async t => {
  const f = await fixture(t);
  assert.throws(() => stripBccHeader(Buffer.from('Bcc: hidden@example.test')), error => error.code === 'OUTBOX_INTEGRITY_FAILED');
  for (const extra of [{ subject: 'Subject\r\nBcc: attacker@example.test' }, { to: ['customer@example.test\r\nRCPT TO: attacker@example.test'] }, { attachments: [{ relativePath: 'a', filename: 'a\r\nBcc: attacker@example.test' }] }]) {
    await assert.rejects(f.tools.mail_prepare({ ...basic, ...extra }));
  }
  assert.equal(f.sent.length, 0); assert.equal(f.appended.length, 0);
});

test('reply and forward server drafts retain source threading and attachments without sending', async t => {
  const binary = Buffer.from([0, 128, 255, 15]);
  const raw = await new MailComposer({ from: 'customer@example.test', replyTo: 'reply@example.test', to: ['sender@example.test', 'teammate@example.test'], cc: 'observer@example.test', subject: 'Original', text: 'Original body', messageId: '<original@example.test>', references: ['<earlier@example.test>'], attachments: [{ filename: 'quote.bin', content: binary }] }).compile().build();
  const f = await fixture(t, { client: { fetchOne: async (_uid, query) => query.source ? { source: raw } : { flags: new Set(['\\Draft']) } } });
  const id = { accountId: 'a', folder: 'INBOX', uid: 501, uidValidity: '7' };
  for (const kind of ['reply', 'reply_all']) {
    const result = await f.tools.mail_save_draft({ ...id, kind, text: 'Draft reply' });
    assert.equal(result.saved, true);
    const parsed = await simpleParser(f.appended.at(-1).raw);
    assert.equal(parsed.to.value[0].address, 'reply@example.test');
    assert.equal(parsed.inReplyTo, '<original@example.test>');
    assert.deepEqual(parsed.references, ['<earlier@example.test>', '<original@example.test>']);
    assert.deepEqual(parsed.cc?.value.map(a => a.address) || [], kind === 'reply_all' ? ['teammate@example.test', 'observer@example.test'] : []);
  }
  await f.tools.mail_save_draft({ ...id, kind: 'forward' });
  const forwarded = await simpleParser(f.appended.at(-1).raw);
  assert.equal(forwarded.to, undefined, 'forward may remain a draft without recipients');
  assert.deepEqual(forwarded.attachments[0].content, binary);
  assert.match(forwarded.text, /Original body/);
  assert.equal(f.sent.length, 0);
  await assert.rejects(f.tools.mail_save_draft({ accountId: 'a', kind: 'reply', text: 'No source IDs' }));
});

test('partial or unconfirmed envelope failure remains unknown despite a rejection error code', async t => {
  const f = await fixture(t, { sendMail: async () => { throw Object.assign(new Error('PRIVATE'), { code: 'EENVELOPE', command: 'RCPT TO', responseCode: 550, rejected: ['customer@example.test'] }); } });
  const p = await f.tools.mail_prepare({ ...basic, cc: ['other@example.test'] });
  const result = await f.tools.mail_send_prepared({ accountId: 'a', operationId: p.operationId });
  assert.equal(result.status, 'unknown'); assert.equal(result.smtpAccepted, null);
  assert.equal(f.appended.length, 0);
});
