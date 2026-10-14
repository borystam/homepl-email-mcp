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
