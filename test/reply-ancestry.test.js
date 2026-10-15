import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { simpleParser } from 'mailparser';
import { writeTools } from '../src/write-tools.js';

async function replyFixture(t, headers) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'home-mail-ancestry-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const source = Buffer.from([
    'From: customer@example.test', 'To: sender@example.test', 'Subject: Re: Topic',
    'Message-ID: <parent@example.test>', ...headers, '', 'Previous reply', '',
  ].join('\r\n'));
  const config = { email: 'sender@example.test', folders: { drafts: 'Drafts' } };
  let savedRaw;
  const client = {
    fetchOne: async () => ({ uid: 501, source }),
    append: async (_folder, raw) => { savedRaw = raw; return { uid: 502, uidValidity: 7n }; },
  };
  const ctx = {
    dataDir, getAccount: async () => config,
    withImap: async (_id, _folder, _options, fn) => fn(client, config),
    withSmtp: async () => assert.fail('Reply preparation and draft saving must never send'),
  };
  const tools = Object.fromEntries(writeTools(ctx).map(tool => [tool.name, args => tool.handler(tool.schema.parse(args))]));
  return async toolName => {
    const result = await tools[toolName]({ accountId: 'a', kind: 'reply', folder: 'INBOX', uid: 501, uidValidity: '7', text: 'Next reply' });
    return simpleParser(toolName === 'mail_prepare' ? await fs.readFile(result.emlPath) : savedRaw);
  };
}

const cases = [
  { name: 'uses the single In-Reply-To ancestor when References is absent', headers: ['In-Reply-To: <grandparent@example.test>'], expected: ['<grandparent@example.test>', '<parent@example.test>'] },
  { name: 'keeps existing References ahead of an unrelated In-Reply-To', headers: ['References: <first@example.test> <second@example.test>', 'In-Reply-To: <unrelated@example.test>'], expected: ['<first@example.test>', '<second@example.test>', '<parent@example.test>'] },
  { name: 'does not infer ancestry from multiple In-Reply-To parents', headers: ['In-Reply-To: <first@example.test> <second@example.test>'], expected: ['<parent@example.test>'] },
  ...['not-an-id', '<missing-at>', '<bad id@example.test>', '<grandparent@example.test> trailing-garbage'].map(value => ({
    name: `ignores malformed In-Reply-To ${JSON.stringify(value)}`, headers: [`In-Reply-To: ${value}`], expected: ['<parent@example.test>'],
  })),
];

for (const toolName of ['mail_prepare', 'mail_save_draft']) {
  for (const scenario of cases) {
    test(`${toolName} ${scenario.name}`, async t => {
      const compose = await replyFixture(t, scenario.headers);
      const parsed = await compose(toolName);
      assert.equal(parsed.inReplyTo, '<parent@example.test>');
      assert.deepEqual([parsed.references || []].flat(), scenario.expected);
    });
  }
}
