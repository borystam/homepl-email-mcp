import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import { readTools, parseHeaders } from '../src/read-tools.js';

function fixture(overrides = {}) {
  const calls = [];
  const files = [];
  let fetchActive = false;
  const records = [3, 18, 501, 2024, 9001].map((uid, i) => ({ uid, seq: i + 1, envelope: { subject: `message ${uid}` }, internalDate: new Date('2001-01-01T00:00:00Z'), flags: new Set(['\\Seen']), size: 1024 }));
  const client = {
    mailbox: { uidValidity: 55n, uidNext: 9002, exists: records.length },
    async search(query, options) {
      assert.equal(fetchActive, false, 'No IMAP operation may run inside fetch iterator');
      calls.push({ method: 'search', query, options });
      const [lower, upper] = query.uid.split(':').map(Number);
      return records.filter(item => item.uid >= lower && item.uid <= upper).map(item => item.uid);
    },
    async *fetch(range, query, options) {
      assert.equal(fetchActive, false); fetchActive = true;
      calls.push({ method: 'fetch', range, query, options });
      try { for (const record of records.filter(item => range.split(',').includes(String(item.uid)))) yield record; }
      finally { fetchActive = false; }
    },
    async fetchOne(id, query, options) {
      assert.equal(fetchActive, false);
      calls.push({ method: 'fetchOne', id, query, options });
      return records.find(item => item.uid === id);
    },
    ...overrides
  };
  const ctx = {
    async withImap(account, folder, options, action) {
      calls.push({ method: 'withImap', account, folder, options });
      return action(client, { email: 'user@example.test' });
    },
    async saveStream(stream, filename) {
      const chunks = [];
      for await (const chunk of stream) chunks.push(chunk);
      const bytes = Buffer.concat(chunks);
      files.push({ filename, bytes });
      return { path: `/private/download-${files.length}`, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
    },
    async saveBuffer(buffer, filename) { return this.saveStream(Readable.from([buffer]), filename); }
  };
  const invoke = async (name, args) => {
    const tool = readTools(ctx).find(item => item.name === name);
    assert.ok(tool, name);
    return tool.handler(tool.schema.parse(args));
  };
  return { client, ctx, records, calls, files, invoke };
}
const ref = { accountId: 'work', folder: 'INBOX', uid: 3, uidValidity: '55' };

test('UID pagination traverses gaps and oldest retained mail without a date cutoff or new-arrival duplicates', async () => {
  const f = fixture();
  const args = { accountId: 'work', folder: 'INBOX', pageSize: 2 };
  const first = await f.invoke('mail_list_messages', args);
  assert.deepEqual(first.messages.map(m => m.uid), [9001, 2024]);
  assert.equal(first.uidValidity, '55');
  assert.ok(first.nextCursor);
  assert.equal(first.messages[0].seq, undefined);
  f.records.push({ uid: 9002, seq: 6 }); f.client.mailbox.uidNext = 9003;
  const second = await f.invoke('mail_list_messages', { ...args, cursor: first.nextCursor });
  assert.deepEqual(second.messages.map(m => m.uid), [501, 18]);
  const third = await f.invoke('mail_list_messages', { ...args, cursor: second.nextCursor });
  assert.deepEqual(third.messages.map(m => m.uid), [3]);
  assert.equal(third.nextCursor, null);
  assert.equal(third.historyExhausted, true);
  assert.equal(third.messages[0].internalDate, '2001-01-01T00:00:00.000Z');
  for (const call of f.calls.filter(c => c.method === 'search' || c.method === 'fetch')) {
    assert.equal(call.options.uid, true);
    assert.equal(call.query.since, undefined);
    assert.equal(call.query.before, undefined);
  }
});

test('search is bounded across sparse UID space and returns an actionable cursor on an empty page', async () => {
  const f = fixture(); f.client.mailbox.uidNext = 1000001;
  const page = await f.invoke('mail_search_messages', { accountId: 'work', folder: 'INBOX', query: { subject: 'old quotation', seen: false } });
  assert.equal(page.messages.length, 0);
  assert.equal(page.scanLimited, true);
  assert.ok(page.nextCursor);
  assert.equal(f.calls.filter(c => c.method === 'search').length, 20);
  assert.equal(f.calls.filter(c => c.method === 'fetch').length, 0);
  for (const call of f.calls.filter(c => c.method === 'search')) {
    const [lo, hi] = call.query.uid.split(':').map(Number);
    assert.ok(hi - lo < 10000);
    assert.equal(call.query.subject, 'old quotation');
    assert.equal(call.query.seen, false);
  }
});

test('cursors are scoped to account, folder, query and UIDVALIDITY', async () => {
  const f = fixture();
  const args = { accountId: 'work', folder: 'INBOX', pageSize: 1, query: { from: 'supplier@example.test' } };
  const page = await f.invoke('mail_search_messages', args);
  for (const change of [{ accountId: 'personal' }, { folder: 'Sent' }, { query: { from: 'other@example.test' } }]) {
    await assert.rejects(f.invoke('mail_search_messages', { ...args, ...change, cursor: page.nextCursor }), /does not match/);
  }
  f.client.mailbox.uidValidity = 56n;
  await assert.rejects(f.invoke('mail_search_messages', { ...args, cursor: page.nextCursor }), /UIDVALIDITY changed/);
});

test('header parser preserves duplicate order, folding and exact non-UTF8 bytes', () => {
  const raw = Buffer.concat([
    Buffer.from('Received: one\r\nReceived: two\r\n\tfolded\r\nX-Bytes: '),
    Buffer.from([0xff, 0x80]), Buffer.from('\r\nSubject: hello\r\n\r\n')
  ]);
  const parsed = parseHeaders(raw);
  assert.deepEqual(parsed.entries.map(e => e.name), ['Received', 'Received', 'X-Bytes', 'Subject']);
  assert.equal(parsed.entries[1].raw, 'Received: two\r\n\tfolded\r\n');
  assert.equal(parsed.entries[1].value, 'two folded');
  assert.deepEqual(Buffer.from(parsed.rawBase64, 'base64'), raw);
  assert.deepEqual(Buffer.from(parsed.entries[2].raw, 'latin1'), Buffer.concat([Buffer.from('X-Bytes: '), Buffer.from([0xff, 0x80]), Buffer.from('\r\n')]));
});

test('raw download preserves every RFC822 binary byte and uses a UID stream, without fetching source into memory', async () => {
  const raw = Buffer.concat([Buffer.from('X-Test: one\r\nX-Test: two\r\n\r\n'), Buffer.from(Array.from({ length: 256 }, (_, n) => n))]);
  const f = fixture({ async download(id, part, options) {
    assert.equal(id, 3); assert.equal(part, undefined); assert.equal(options.uid, true);
    return { content: Readable.from([raw.subarray(0, 29), raw.subarray(29)]), meta: { contentType: 'message/rfc822' } };
  } });
  const result = await f.invoke('mail_download_raw', ref);
  assert.deepEqual(f.files[0].bytes, raw);
  assert.equal(result.file.sha256, createHash('sha256').update(raw).digest('hex'));
  assert.equal(result.file.bytes, raw.length);
  assert.equal(f.calls.some(call => call.query?.source), false);
});

test('MIME part IDs distinguish repeated filenames and preserve arbitrary binary attachments', async () => {
  const binary = Buffer.from([0, 255, 254, 128, 13, 10, 1]);
  const f = fixture({ async download(id, part, options) {
    assert.equal(id, 3); assert.equal(part, '3'); assert.equal(options.uid, true);
    return { content: Readable.from([binary]), meta: { filename: 'same.bin', contentType: 'application/octet-stream' } };
  } });
  f.records[0].bodyStructure = { type: 'multipart/mixed', childNodes: [
    { part: '1', type: 'text/plain' },
    { part: '2', type: 'application/octet-stream', disposition: 'attachment', dispositionParameters: { filename: 'same.bin' } },
    { part: '3', type: 'application/octet-stream', disposition: 'attachment', dispositionParameters: { filename: 'same.bin' } }
  ] };
  const result = await f.invoke('mail_download_attachment', { ...ref, partId: '3' });
  assert.equal(result.part.partId, '3');
  assert.deepEqual(f.files[0].bytes, binary);
  await assert.rejects(f.invoke('mail_download_attachment', { ...ref, partId: '4' }), /MIME part not found/);
});

test('message body previews have one shared byte budget while full text and HTML are saved', async () => {
  const payload = Buffer.from('Zażółć gęślą jaźń '.repeat(1000));
  const f = fixture({ async download(id, part, options) {
    assert.equal(options.uid, true);
    return { content: Readable.from([payload.subarray(0, 100), payload.subarray(100)]), meta: { contentType: part === '1' ? 'text/plain' : 'text/html', charset: 'utf-8' } };
  } });
  f.records[0].headers = Buffer.from('Received: one\r\nReceived: two\r\n\r\n');
  f.records[0].bodyStructure = { type: 'multipart/alternative', childNodes: [{ part: '1', type: 'text/plain' }, { part: '2', type: 'text/html' }] };
  const result = await f.invoke('mail_get_message', { ...ref, previewBytes: 256 });
  assert.equal(result.bodies.length, 2);
  assert.ok(result.bodies.reduce((sum, body) => sum + Buffer.byteLength(body.preview ?? ''), 0) <= 256);
  assert.equal(result.bodies[0].previewTruncated, true);
  assert.equal(result.headers.entries.length, 2);
  assert.equal(result.bodyPartsNotFetched.length, 0);
  assert.deepEqual(f.files.map(file => file.bytes), [payload, payload]);
  assert.equal(result.seq, undefined);
});

test('folder status serializes UIDVALIDITY, flags and all listed unsubscribed folders', async () => {
  const f = fixture({ async list(options) {
    assert.equal(options.statusQuery.uidValidity, true);
    return [{ path: 'Archive/2001', flags: new Set(), subscribed: false, status: { messages: 50, uidValidity: 2n } }];
  } });
  const result = await f.invoke('mail_folders', { accountId: 'work' });
  assert.equal(result.folders[0].subscribed, false);
  assert.equal(result.folders[0].status.uidValidity, '2');
  assert.doesNotThrow(() => JSON.stringify(result));
});

test('attached and inline RFC822 messages retain unique wrapper and nested part targets', async () => {
  const nested = Buffer.from('From: sender@example.test\r\nSubject: nested\r\n\r\nnested body\r\n');
  const f = fixture({ async download(id, part, options) {
    assert.equal(options.uid, true);
    return { content: Readable.from([part === '2' ? nested : Buffer.from('nested body\r\n')]), meta: { contentType: part === '2' ? 'message/rfc822' : 'text/plain' } };
  } });
  // Actual ImapFlow shape: embedded root reuses the wrapper's part ID.
  f.records[0].bodyStructure = { type: 'multipart/mixed', childNodes: [
    { part: '1', type: 'text/plain' },
    { part: '2', type: 'message/rfc822', disposition: 'attachment', childNodes: [{ part: '2', type: 'text/plain' }] },
    { part: '3', type: 'message/rfc822', disposition: 'inline', childNodes: [{ part: '3', type: 'multipart/mixed', childNodes: [
      { part: '3.1', type: 'text/plain' }, { part: '3.2', type: 'application/pdf', disposition: 'attachment' }
    ] }] }
  ] };
  const message = await f.invoke('mail_get_message', { ...ref, includeBodies: false });
  assert.deepEqual(message.parts.map(part => part.partId), ['1', '2', '2.1', '3', '3.1', '3.2']);
  assert.deepEqual(message.bodyPartsNotFetched, ['1'], 'Embedded email bodies must not be confused with the outer email body');
  const download = await f.invoke('mail_download_attachment', { ...ref, partId: '2' });
  assert.equal(download.part.contentType, 'message/rfc822');
  assert.deepEqual(f.files[0].bytes, nested);
  const nestedPart = await f.invoke('mail_download_attachment', { ...ref, partId: '2.1' });
  assert.equal(nestedPart.part.contentType, 'text/plain');
});

test('invalid cursor and missing MIME errors carry safe machine-actionable codes', async () => {
  const f = fixture();
  await assert.rejects(f.invoke('mail_list_messages', { accountId: 'work', folder: 'INBOX', cursor: Buffer.from('null').toString('base64url') }), { code: 'CURSOR_SCOPE_MISMATCH' });
  await assert.rejects(f.invoke('mail_get_message', { ...ref, uid: 999 }), { code: 'MESSAGE_NOT_FOUND' });
  await assert.rejects(f.invoke('mail_search_messages', { accountId: 'work', folder: 'INBOX', query: { headers: { 'Message-ID': false } } }), /Invalid input/);
});

test('invalid calendar dates are rejected before IMAP can silently drop the filter', async () => {
  const f = fixture();
  for (const since of ['2026-02-30', '2026-13-01', '2025-02-29']) {
    await assert.rejects(f.invoke('mail_search_messages', { accountId: 'work', folder: 'INBOX', query: { since } }));
  }
  assert.equal(f.calls.length, 0);
  const valid = await f.invoke('mail_search_messages', { accountId: 'work', folder: 'INBOX', query: { since: '2024-02-29' } });
  assert.ok(valid.messages.length);
});

test('invalid or missing server UIDNEXT must not claim the entire history is empty', async () => {
  for (const value of [0, -1, null, undefined, NaN, 1.5, '9002']) {
    const f = fixture(); f.client.mailbox.uidNext = value;
    await assert.rejects(f.invoke('mail_list_messages', { accountId: 'work', folder: 'INBOX' }), { code: 'INVALID_SERVER_UIDNEXT' });
  }
});

test('duplicate FETCH updates merge by UID instead of duplicating page results', async () => {
  const f = fixture({ async *fetch(range, query, options) {
    assert.equal(options.uid, true);
    yield { uid: 9001, seq: 5, envelope: { subject: 'original' }, flags: new Set() };
    yield { uid: 9001, seq: 5, flags: new Set(['\\Seen']) };
    yield { uid: 777777, seq: 6, envelope: { subject: 'unsolicited foreign message' } };
  } });
  const page = await f.invoke('mail_list_messages', { accountId: 'work', folder: 'INBOX', pageSize: 1 });
  assert.equal(page.messages.length, 1);
  assert.equal(page.messages[0].envelope.subject, 'original');
  assert.deepEqual(page.messages[0].flags, ['\\Seen']);
});

test('preview budget counts final UTF8 bytes, including unknown encodings and invalid input', async () => {
  const payload = Buffer.alloc(900, 0xff);
  const f = fixture({ async download() {
    return { content: Readable.from([payload]), meta: { contentType: 'text/plain', charset: 'unknown-charset' } };
  } });
  f.records[0].bodyStructure = { type: 'text/plain' };
  const result = await f.invoke('mail_get_message', { ...ref, previewBytes: 256 });
  assert.ok(Buffer.byteLength(result.bodies[0].preview, 'utf8') <= 256);
  assert.equal(result.bodies[0].previewTruncated, true);
  assert.deepEqual(f.files[0].bytes, payload);
});

test('large metadata is saved losslessly while serialized tool output retains its cursor within 64 KiB', async () => {
  const f = fixture();
  const giant = 'same-large-value-'.repeat(20000);
  f.records.at(-1).envelope.subject = giant;
  f.records.at(-1).bodyStructure = { type: 'multipart/mixed', childNodes: [{ part: '1', type: 'application/pdf', dispositionParameters: { filename: giant } }] };
  const page = await f.invoke('mail_list_messages', { accountId: 'work', folder: 'INBOX', pageSize: 2 });
  assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 65536);
  assert.equal(page.outputTruncated, true);
  assert.ok(page.completeResultFile.path);
  assert.ok(page.nextCursor);
  assert.deepEqual(page.messages.map(message => message.uid), [9001, 2024]);
  const full = JSON.parse(f.files.find(file => file.filename.endsWith('.json')).bytes);
  assert.equal(full.messages[0].envelope.subject, giant);
  assert.equal(full.nextCursor, page.nextCursor);
});

test('expunge between SEARCH and FETCH reports the missing UID and pagination still reaches old mail', async () => {
  const f = fixture();
  const originalFetch = f.client.fetch.bind(f.client);
  f.client.fetch = async function* (range, query, options) {
    f.records.splice(f.records.findIndex(record => record.uid === 9001), 1);
    yield* originalFetch(range, query, options);
    f.client.fetch = originalFetch;
  };
  const first = await f.invoke('mail_list_messages', { accountId: 'work', folder: 'INBOX', pageSize: 2 });
  assert.deepEqual(first.messages.map(message => message.uid), [2024]);
  assert.deepEqual(first.missingUids, [9001]);
  const second = await f.invoke('mail_list_messages', { accountId: 'work', folder: 'INBOX', pageSize: 100, cursor: first.nextCursor });
  assert.deepEqual(second.messages.map(message => message.uid), [501, 18, 3]);
  assert.equal(second.nextCursor, null);
});

test('sparse history traverses multiple empty pages without skipping retained UIDs', async () => {
  const f = fixture(); f.client.mailbox.uidNext = 450002;
  f.records.push({ uid: 450001, seq: 6 });
  const seen = [];
  let cursor;
  let pages = 0;
  do {
    const page = await f.invoke('mail_list_messages', { accountId: 'work', folder: 'INBOX', pageSize: 2, ...(cursor ? { cursor } : {}) });
    seen.push(...page.messages.map(message => message.uid));
    cursor = page.nextCursor;
    assert.ok(++pages < 10, 'Bounded sparse scan must make forward progress');
  } while (cursor);
  assert.deepEqual(seen, [450001, 9001, 2024, 501, 18, 3]);
});

test('cursor from another account is rejected before opening any account connection', async () => {
  const f = fixture();
  const first = await f.invoke('mail_list_messages', { accountId: 'work', folder: 'INBOX', pageSize: 1 });
  f.calls.length = 0;
  await assert.rejects(f.invoke('mail_list_messages', { accountId: 'personal', folder: 'INBOX', cursor: first.nextCursor }), { code: 'CURSOR_SCOPE_MISMATCH' });
  assert.equal(f.calls.length, 0);
});

test('large duplicate headers keep exact complete bytes and bounded serialized output', async () => {
  const f = fixture();
  const header = Buffer.concat([Buffer.from('Received: old\r\nReceived: new\r\nX-Bytes: '), Buffer.alloc(90000, 0xff), Buffer.from('\r\n\r\n')]);
  f.records[0].headers = header;
  const result = await f.invoke('mail_get_message', { ...ref, includeBodies: false, headerPreviewBytes: 1024 });
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 65536);
  assert.equal(result.headers.truncated, true);
  assert.deepEqual(result.headers.entries.slice(0, 2).map(item => item.name), ['Received', 'Received']);
  assert.deepEqual(f.files.find(file => file.filename.endsWith('-headers.txt')).bytes, header);
  assert.equal(result.headers.completeFile.bytes, header.length);
});

test('output budget fallback preserves every header byte in the complete result file', async () => {
  const f = fixture();
  const header = Buffer.concat([Buffer.from('X-Bytes: '), Buffer.alloc(24000, 0x01), Buffer.from('\r\n\r\n')]);
  f.records[0].headers = header;
  const result = await f.invoke('mail_get_message', { ...ref, includeBodies: false });
  assert.equal(result.outputTruncated, true);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 65536);
  const full = JSON.parse(f.files.find(file => file.filename.endsWith('.json')).bytes);
  assert.deepEqual(Buffer.from(full.headers.rawBase64, 'base64'), header);
  assert.equal(full.uid, 3);
  assert.equal(full.uidValidity, '55');
});

test('download errors never return a successful partial file', async () => {
  const failure = Object.assign(new Error('synthetic transport failure'), { code: 'ECONNRESET' });
  const stream = Readable.from((async function* () { yield Buffer.from('partial'); throw failure; })());
  const f = fixture({ async download() { return { content: stream, meta: {} }; } });
  await assert.rejects(f.invoke('mail_download_raw', ref), failure);
  assert.equal(stream.destroyed, true);
  assert.equal(f.files.length, 0);
});

test('failure opening the destination destroys both stream layers without consuming the mailbox body', async () => {
  let consumed = false;
  const stream = Readable.from((async function* () { consumed = true; yield Buffer.from('unread'); })());
  const f = fixture({ async download() { return { content: stream, meta: {} }; } });
  let outer;
  f.ctx.saveStream = async input => { outer = input; throw Object.assign(new Error('synthetic disk failure'), { code: 'ENOSPC' }); };
  await assert.rejects(f.invoke('mail_download_raw', ref), { code: 'ENOSPC' });
  assert.equal(stream.destroyed, true);
  assert.equal(outer.destroyed, true);
  assert.equal(consumed, false);
});

test('single-part non-UTF8 body preview decodes text while preserving the downloaded bytes', async () => {
  const encoded = Buffer.from([0xa1, 0xb1, 0xc6, 0xe6, 0xa3, 0xb3]);
  const f = fixture({ async download(id, part) {
    assert.equal(part, '1');
    return { content: Readable.from([encoded]), meta: { contentType: 'text/plain', charset: 'iso-8859-2' } };
  } });
  f.records[0].bodyStructure = { type: 'text/plain', parameters: { charset: 'iso-8859-2' } };
  const result = await f.invoke('mail_get_message', ref);
  assert.equal(result.bodies[0].preview, 'ĄąĆćŁł');
  assert.equal(result.bodies[0].previewTruncated, false);
  assert.deepEqual(f.files[0].bytes, encoded);
});

test('inline attachment content IDs and duplicate names remain separate from body previews', async () => {
  const f = fixture();
  f.records[0].bodyStructure = { type: 'multipart/related', childNodes: [
    { type: 'text/html', part: '1' },
    { type: 'image/png', part: '2', id: '<first-image>', disposition: 'inline', dispositionParameters: { filename: 'same.png' } },
    { type: 'image/png', part: '3', id: '<second-image>', disposition: 'inline', dispositionParameters: { filename: 'same.png' } }
  ] };
  const result = await f.invoke('mail_get_message', { ...ref, includeBodies: false });
  assert.deepEqual(result.bodyPartsNotFetched, ['1']);
  assert.deepEqual(result.parts.slice(1).map(part => [part.partId, part.contentId, part.filename]), [
    ['2', '<first-image>', 'same.png'], ['3', '<second-image>', 'same.png']
  ]);
});
