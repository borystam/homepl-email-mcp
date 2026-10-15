import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, writeFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import hoodiecrow from 'hoodiecrow-imap';
import { SMTPServer } from 'smtp-server';
import { ImapFlow } from 'imapflow';
import nodemailer from 'nodemailer';
import tls from 'node:tls';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createContext } from '../src/context.js';
import { makeServer } from '../src/server.js';
import { verifyAccount } from '../src/setup.js';

const run = promisify(execFile);
const email = 'tls-fixture@example.invalid';
const password = 'synthetic-tls-password-only';
const wrongPassword = 'synthetic-wrong-password-only';
const privateProviderError = 'PRIVATE_PROVIDER_DIAGNOSTIC_DO_NOT_EXPOSE';

async function environment(t) {
  try { await run('openssl', ['version'], { timeout: 5000 }); }
  catch (error) {
    if (error.code === 'ENOENT') { t.skip('OpenSSL is unavailable; synthetic TLS certificate cannot be generated.'); return null; }
    throw error;
  }
  const root = await mkdtemp(join(tmpdir(), 'homepl-tls-integration-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const keyPath = join(root, 'fixture.key');
  const certPath = join(root, 'fixture.crt');
  const configPath = join(root, 'openssl.cnf');
  await writeFile(configPath, '[req]\nprompt=no\ndistinguished_name=dn\nx509_extensions=extensions\n[dn]\nCN=localhost\n[extensions]\nsubjectAltName=DNS:localhost,IP:127.0.0.1\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,digitalSignature,keyEncipherment,keyCertSign\nextendedKeyUsage=serverAuth\n', { mode: 0o600 });
  await run('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-sha256', '-nodes', '-days', '1', '-config', configPath, '-keyout', keyPath, '-out', certPath], { timeout: 15000 });
  await chmod(keyPath, 0o600);
  const [key, cert] = await Promise.all([readFile(keyPath), readFile(certPath)]);
  const imap = hoodiecrow({
    // Hoodiecrow names its implicit TLS setting secureConnection.
    secureConnection: true, credentials: { key, cert },
    plugins: ['AUTH-PLAIN', 'SASL-IR', 'UIDPLUS', 'SPECIAL-USE'],
    users: { [email]: { password } },
    storage: { INBOX: { uidvalidity: 7, messages: [] }, '': { separator: '/', folders: { Sent: { 'special-use': '\\Sent' } } } },
  });
  let smtpAuthentications = 0;
  let smtpDataCalls = 0;
  const smtp = new SMTPServer({
    secure: true, key, cert, logger: false, authOptional: false,
    onAuth(auth, session, callback) {
      smtpAuthentications++;
      if (!session.secure) return callback(new Error('TLS fixture unexpectedly received cleartext authentication'));
      if (auth.username !== email || auth.password !== password) return callback(new Error(privateProviderError));
      callback(null, { user: email });
    },
    onData(stream, _session, callback) { smtpDataCalls++; stream.resume(); stream.once('end', callback); },
  });
  // Certificate-rejection tests deliberately abort TLS handshakes. The fixture
  // must handle those server-side events without treating them as uncaught errors.
  imap.server.on('tlsClientError', () => {});
  smtp.on('error', () => {});
  const sockets = new Set();
  for (const server of [imap.server, smtp.server]) server.on('connection', socket => {
    sockets.add(socket); socket.once('close', () => sockets.delete(socket));
  });
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await Promise.all([
      new Promise(resolve => imap.server.listening ? imap.close(resolve) : resolve()),
      new Promise(resolve => smtp.server.listening ? smtp.close(resolve) : resolve()),
    ]);
  });
  await new Promise((resolve, reject) => { imap.server.once('error', reject); imap.listen(0, '127.0.0.1', resolve); });
  await new Promise((resolve, reject) => { smtp.server.once('error', reject); smtp.listen(0, '127.0.0.1', resolve); });
  const account = { id: 'tls', email, imap: { host: 'fixture.invalid', port: 993 }, smtp: { host: 'fixture.invalid', port: 465 }, folders: { sent: 'Sent' } };
  let contextNumber = 0;
  const factories = ({ trusted = true, servername = 'localhost', smtpServername = servername } = {}) => ({
    imapFactory: settings => {
      assert.equal(settings.secure, true); assert.equal(settings.tls.rejectUnauthorized, true);
      return new ImapFlow({ ...settings, host: '127.0.0.1', port: imap.server.address().port, disableAutoEnable: true, connectionTimeout: 3000, greetingTimeout: 3000, socketTimeout: 3000, tls: { ...settings.tls, servername, ...(trusted === true ? { ca: cert } : {}) } });
    },
    smtpFactory: settings => {
      assert.equal(settings.secure, true); assert.equal(settings.tls.rejectUnauthorized, true);
      return nodemailer.createTransport({ ...settings, host: '127.0.0.1', port: smtp.server.address().port, connectionTimeout: 3000, greetingTimeout: 3000, socketTimeout: 3000, tls: { ...settings.tls, servername: smtpServername, ...(trusted === true ? { ca: cert } : {}) } });
    },
  });
  const context = (options = {}) => createContext({
    dataDir: join(root, `context-${++contextNumber}`), getAccount: async id => { assert.equal(id, 'tls'); return account; },
    getPassword: async () => options.credential ?? password, ...factories(options),
  });
  return { context, account, cert: cert.toString(), verify: options => verifyAccount(account, password, factories(options)),
    counters: () => ({ smtpAuthentications, smtpDataCalls }) };
}

test('implicit TLS mail transport validates certificates and authentication on loopback', { timeout: 30000 }, async t => {
  const fixture = await environment(t);
  if (!fixture) return;

  await t.test('trusted synthetic certificate and correct password permit IMAP and SMTP authentication', async () => {
    const ctx = await fixture.context();
    const folders = await ctx.withImap('tls', null, {}, async client => {
      assert.equal(client.socket.encrypted, true);
      assert.equal(client.socket.authorized, true);
      return client.list();
    });
    assert.ok(folders.some(folder => folder.path === 'INBOX'));
    assert.equal(await ctx.withSmtp('tls', transport => transport.verify()), true);
    assert.ok(fixture.counters().smtpAuthentications > 0);
  });

  await t.test('wrong password fails both protocols over trusted TLS', async () => {
    const ctx = await fixture.context({ credential: wrongPassword });
    await assert.rejects(ctx.withImap('tls', null, {}, client => client.list()), error => error.authenticationFailed === true);
    await assert.rejects(ctx.withSmtp('tls', transport => transport.verify()), error => error.code === 'EAUTH');
  });

  await t.test('untrusted certificate fails both protocols before SMTP authentication', async () => {
    const before = fixture.counters().smtpAuthentications;
    const ctx = await fixture.context({ trusted: false });
    await assert.rejects(ctx.withImap('tls', null, {}, client => client.list()), /certificate|self.signed/i);
    await assert.rejects(ctx.withSmtp('tls', transport => transport.verify()), /certificate|self.signed/i);
    assert.equal(fixture.counters().smtpAuthentications, before);
  });

  await t.test('trusted issuer does not bypass hostname validation', async () => {
    const ctx = await fixture.context({ servername: 'wrong-host.example.invalid' });
    await assert.rejects(ctx.withImap('tls', null, {}, client => client.list()), /altname|hostname|certificate/i);
    await assert.rejects(ctx.withSmtp('tls', transport => transport.verify()), /altname|hostname|certificate/i);
  });

  await t.test('OS-trusted scanning certificate works in setup and later mail use without CA overrides', async t => {
    const original = tls.getCACertificates.bind(tls);
    t.mock.method(tls, 'getCACertificates', type => type === 'system' ? [fixture.cert] : original(type));
    const ctx = await fixture.context({ trusted: 'system' });
    assert.ok((await ctx.withImap('tls', null, {}, client => client.list())).some(folder => folder.path === 'INBOX'));
    assert.equal(await ctx.withSmtp('tls', transport => transport.verify()), true);
    assert.equal((await fixture.verify({ trusted: 'system' })).sent, 'Sent');
    await assert.rejects(fixture.verify({ trusted: 'system', servername: 'wrong.example.invalid' }), { code: 'IMAP_TLS' });
    const before = fixture.counters().smtpAuthentications;
    await assert.rejects(fixture.verify({ trusted: 'system', smtpServername: 'wrong.example.invalid' }), { code: 'SMTP_TLS' });
    assert.equal(fixture.counters().smtpAuthentications, before);
  });

  await t.test('setup rejects an untrusted scanning certificate', async () => {
    await assert.rejects(fixture.verify({ trusted: false }), { code: 'IMAP_TLS' });
  });

  await t.test('MCP responses hide credentials and private provider authentication diagnostics', async t => {
    const ctx = await fixture.context({ credential: wrongPassword });
    const server = await makeServer({ ctx, listAccounts: async () => [fixture.account] });
    const client = new Client({ name: 'tls-fixture', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    t.after(async () => { await client.close(); await server.close(); });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const read = await client.callTool({ name: 'mail_folders', arguments: { accountId: 'tls' } });
    assert.equal(read.isError, true);
    const prepared = await client.callTool({ name: 'mail_prepare', arguments: { accountId: 'tls', to: ['recipient@example.invalid'], text: 'Synthetic test only' } });
    const operationId = JSON.parse(prepared.content[0].text).operationId;
    const sent = await client.callTool({ name: 'mail_send_prepared', arguments: { accountId: 'tls', operationId } });
    const outcome = JSON.parse(sent.content[0].text);
    assert.equal(outcome.smtpAccepted, false);
    assert.equal(outcome.status, 'rejected');
    const output = JSON.stringify({ read, sent });
    for (const secret of [password, wrongPassword, privateProviderError]) assert.ok(!output.includes(secret));
    assert.equal(fixture.counters().smtpDataCalls, 0, 'authentication failures must never transmit a message');
  });
});
