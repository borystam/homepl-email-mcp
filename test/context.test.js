import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, readFile, symlink, rm, realpath, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { Readable } from 'node:stream';
import { createContext } from '../src/context.js';

async function fixture(t, options={}) {
  const dir = await mkdtemp(join(tmpdir(), 'home-mail-context-'));
  t.after(() => rm(dir, {recursive:true, force:true}));
  return createContext({dataDir: dir, ...options});
}

test('download preserves arbitrary bytes, duplicate names and confines filenames', async t => {
  const ctx = await fixture(t);
  const bytes = Buffer.from([0, 255, 13, 10, 200, 42]);
  const one = await ctx.saveStream(Readable.from([bytes]), '../../same.bin');
  const two = await ctx.saveBuffer(bytes, '../../same.bin');
  assert.notEqual(one.path, two.path);
  assert.equal(one.bytes, bytes.length);
  assert.equal(one.sha256, two.sha256);
  assert.deepEqual(await readFile(one.path), bytes);
  assert.ok(one.path.startsWith(ctx.downloadDir));
});

test('outgoing attachment file access rejects traversal and symlink escapes', async t => {
  const ctx = await fixture(t);
  await writeFile(join(ctx.uploadDir,'ok.txt'),'ok');
  assert.equal(await ctx.readUpload('ok.txt'), await realpath(join(ctx.uploadDir,'ok.txt')));
  await writeFile(join(ctx.dataDir,'outside.txt'),'private');
  await assert.rejects(ctx.readUpload('../outside.txt'));
  // Symlink creation on Windows needs privileges; junction directories do not.
  await mkdir(join(ctx.dataDir,'outside'));
  await writeFile(join(ctx.dataDir,'outside','secret.txt'),'private');
  await symlink(join(ctx.dataDir,'outside'), join(ctx.uploadDir,'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(ctx.readUpload('escape/secret.txt'));
});

test('message UIDVALIDITY change prevents operation and still releases connection', async t => {
  let called = false, released = false, closed = false;
  const ctx = await fixture(t, {
    getAccount: async () => ({email:'fixture@example.invalid', imap:{host:'example.invalid', port:993}}),
    getPassword: async () => 'synthetic',
    imapFactory: settings => {
      assert.equal(settings.secure,true);
      assert.equal(settings.tls.rejectUnauthorized,true);
      assert.equal(settings.logger,false);
      return { mailbox:{uidValidity:99n}, connect:async()=>{}, getMailboxLock:async(_f, options)=>{assert.equal(options.readOnly,true);return {release(){released=true;}};}, logout:async()=>{closed=true;} };
    },
  });
  await assert.rejects(ctx.withImap('work','INBOX',{uidValidity:'98'},()=>{called=true;}), {code:'UIDVALIDITY_CHANGED'});
  assert.equal(called,false); assert.equal(released,true); assert.equal(closed,true);
});

test('long Unicode attachment names remain downloadable without losing content', async t => {
  const ctx = await fixture(t);
  const file = await ctx.saveBuffer(Buffer.from('payload'), '合約'.repeat(100) + '.pdf');
  assert.ok(Buffer.byteLength(basename(file.path)) <= 255, 'must fit a Linux filesystem filename');
  assert.equal((await readFile(file.path)).toString(), 'payload');
});

test('interrupted download removes the incomplete private file', async t => {
  const ctx = await fixture(t);
  const source = Readable.from((async function* () {
    yield Buffer.alloc(1024 * 1024, 42);
    throw new Error('synthetic interrupted download');
  })());
  await assert.rejects(ctx.saveStream(source, 'large.bin'), /interrupted/);
  assert.deepEqual(await readdir(ctx.downloadDir), []);
});

test('streaming multi-megabyte attachment retains every byte', async t => {
  const ctx = await fixture(t);
  const chunk = Buffer.alloc(64 * 1024, 173);
  const file = await ctx.saveStream(Readable.from((async function* () {
    for (let n = 0; n < 128; n++) yield chunk;
  })()), 'large.bin');
  const actual = await readFile(file.path);
  assert.equal(file.bytes, 8 * 1024 * 1024);
  assert.deepEqual(actual, Buffer.alloc(8 * 1024 * 1024, 173));
});
