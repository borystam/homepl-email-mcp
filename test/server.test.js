import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createContext } from '../src/context.js';
import { makeServer } from '../src/server.js';

async function fixture(t, withImap) {
  const directory = await mkdtemp(join(tmpdir(), 'homepl-server-'));
  const ctx = { ...await createContext({ dataDir: directory }), withImap };
  const server = await makeServer({ ctx, listAccounts: async () => [] });
  const client = new Client({ name: 'boundary-fixture', version: '1' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  t.after(async () => { await client.close(); await server.close(); await rm(directory, { recursive: true, force: true }); });
  return client;
}

const ref = { accountId: 'fixture', folder: 'INBOX', uid: 1, uidValidity: '17' };

test('MCP sanitizes both provider exception text and unrecognized uppercase error codes', async t => {
  const client = await fixture(t, async () => { throw Object.assign(new Error('password synthetic-private-message'), { code: 'SYNTHETIC_SECRET_PASSWORD' }); });
  for (const call of [
    { name: 'mail_folders', arguments: { accountId: 'fixture' } },
    { name: 'mail_get_messages', arguments: { messages: [ref] } },
  ]) {
    const result = await client.callTool(call);
    const text = JSON.stringify(result);
    assert.ok(!text.includes('SYNTHETIC_SECRET_PASSWORD'));
    assert.ok(!text.includes('synthetic-private-message'));
    assert.ok(text.includes('MAIL_OPERATION_FAILED'));
  }
});

test('batch metadata output is bounded and the complete ordered data stays in a local file', async t => {
  const header = Buffer.from(`X-Large: ${'a'.repeat(6000)}\r\n\r\n`);
  const client = await fixture(t, async (_account, _folder, _settings, fn) => fn({
    mailbox: { uidValidity: 17n },
    fetchOne: async uid => ({ uid: Number(uid), headers: header, envelope: { subject: 'long'.repeat(1000) }, bodyStructure: { type: 'text/plain', part: '1' } }),
  }));
  const references = Array.from({ length: 10 }, (_, n) => ({ ...ref, uid: n + 1 }));
  const response = await client.callTool({ name: 'mail_get_messages', arguments: { messages: references } });
  assert.ok(!response.isError);
  assert.ok(Buffer.byteLength(response.content[0].text) < 65536);
  const result = JSON.parse(response.content[0].text);
  assert.equal(result.inlineTruncated, true);
  const complete = JSON.parse(await readFile(result.fullResultFile.path, 'utf8'));
  assert.deepEqual(complete.results.map(item => item.reference), references);
  assert.ok(complete.results.every(item => Buffer.from(item.result.headers.rawBase64, 'base64').equals(header)));
  const invalid = await client.callTool({ name: 'mail_get_messages', arguments: { messages: [...references, ref] } });
  assert.equal(invalid.isError, true);
});
