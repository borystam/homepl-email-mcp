import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import nodemailer from 'nodemailer';
import { SMTPServer } from 'smtp-server';
import { simpleParser } from 'mailparser';
import { createContext } from '../src/context.js';
import { writeTools } from '../src/write-tools.js';

const privateReply = 'PRIVATE_PROVIDER_DIAGNOSTIC_DO_NOT_EXPOSE';

async function fixture(t, failure) {
  const dataDir = await mkdtemp(join(tmpdir(), 'homepl-smtp-rejection-'));
  const calls = { auth: 0, mail: 0, rcpt: 0, data: 0, imap: 0 };
  const sockets = new Set();
  let providerError;
  const smtp = new SMTPServer({
    secure: false, logger: false, disabledCommands: ['STARTTLS'],
    allowInsecureAuth: true, authMethods: ['PLAIN'],
    onAuth(_auth, _session, callback) {
      calls.auth++;
      if (failure === 'auth') return callback(Object.assign(new Error(privateReply), { responseCode: 535 }));
      callback(null, { user: 'synthetic' });
    },
    onMailFrom(_address, _session, callback) {
      calls.mail++;
      if (failure === 'sender') return callback(Object.assign(new Error(privateReply), { responseCode: 550 }));
      callback();
    },
    onRcptTo(_address, _session, callback) { calls.rcpt++; callback(); },
    onData(stream, _session, callback) {
      calls.data++;
      stream.resume();
      stream.once('end', () => {
        if (failure === 'disconnect') {
          for (const socket of sockets) socket.destroy();
        } else if (failure !== 'timeout') {
          callback(Object.assign(new Error(privateReply), { responseCode: 550 }));
        }
      });
    },
  });
  smtp.server.on('connection', socket => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => smtp.server.listening ? smtp.close(resolve) : resolve());
    await rm(dataDir, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => {
    smtp.server.once('error', reject);
    smtp.listen(0, '127.0.0.1', resolve);
  });
  const ctx = await createContext({
    dataDir,
    getAccount: async () => ({ email: 'sender@example.invalid', smtp: { host: 'fixture.invalid', port: 465 } }),
    getPassword: async () => 'synthetic-password',
    imapFactory: () => { calls.imap++; throw new Error('Rejected sends must not append to Sent'); },
    smtpFactory: settings => {
      // Only this synthetic loopback fixture uses cleartext SMTP.
      const transport = nodemailer.createTransport({
        ...settings, host: '127.0.0.1', port: smtp.server.address().port,
        secure: false, ignoreTLS: true, socketTimeout: 1000,
      });
      const sendMail = transport.sendMail.bind(transport);
      transport.sendMail = async args => {
        try { return await sendMail(args); }
        catch (error) {
          providerError = { code: error.code, command: error.command, responseCode: error.responseCode };
          throw error;
        }
      };
      return transport;
    },
  });
  const tools = Object.fromEntries(writeTools(ctx).map(tool => [tool.name, args => tool.handler(tool.schema.parse(args))]));
  const prepared = await tools.mail_prepare({ accountId: 'synthetic', to: ['recipient@example.invalid'], subject: 'Synthetic rejection', text: 'Synthetic message' });
  const reference = { accountId: 'synthetic', operationId: prepared.operationId };
  return {
    calls, tools, reference, error: () => providerError,
    state: async () => JSON.parse(await readFile(join(dataDir, 'outbox', prepared.operationId, 'state.json'), 'utf8')),
  };
}

for (const [failure, expectedError, expectedCalls] of [
  ['auth', { code: 'EAUTH', command: 'AUTH PLAIN', responseCode: 535 }, { auth: 1, mail: 0, rcpt: 0, data: 0, imap: 0 }],
  ['sender', { code: 'EENVELOPE', command: 'MAIL FROM', responseCode: 550 }, { auth: 1, mail: 1, rcpt: 0, data: 0, imap: 0 }],
  ['data', { code: 'EMESSAGE', command: 'DATA', responseCode: 550 }, { auth: 1, mail: 1, rcpt: 1, data: 1, imap: 0 }],
]) {
  test(`explicit SMTP ${failure} rejection is known, private, persisted and never resent`, { timeout: 10000 }, async t => {
    const f = await fixture(t, failure);
    const result = await f.tools.mail_send_prepared(f.reference);
    assert.deepEqual(f.error(), expectedError, 'exercise the real Nodemailer rejection shape');
    assert.deepEqual(f.calls, expectedCalls);
    assert.equal(result.status, 'rejected');
    assert.equal(result.smtpAccepted, false);
    assert.equal(result.retryAllowed, false);
    const state = await f.state();
    assert.equal(state.status, 'rejected');
    assert.equal(state.outcome.smtpAccepted, false);
    const repeated = await f.tools.mail_send_prepared(f.reference);
    assert.equal(repeated.status, 'rejected');
    assert.equal(repeated.retryAllowed, false);
    assert.deepEqual(f.calls, expectedCalls, 'repeat must not open another SMTP transaction');
    assert.ok(!JSON.stringify({ result, state, repeated }).includes(privateReply));
  });
}

for (const failure of ['disconnect', 'timeout']) {
  test(`SMTP ${failure} after DATA stays unknown and never resends`, { timeout: 10000 }, async t => {
    const f = await fixture(t, failure);
    const result = await f.tools.mail_send_prepared(f.reference);
    assert.equal(f.calls.data, 1, 'the fixture must receive DATA before failing');
    assert.equal(result.status, 'unknown');
    assert.equal(result.smtpAccepted, null);
    const state = await f.state();
    assert.equal(state.status, 'unknown');
    assert.equal(state.outcome.smtpAccepted, null);
    const calls = { ...f.calls };
    const repeated = await f.tools.mail_send_prepared(f.reference);
    assert.equal(repeated.status, 'unknown');
    assert.equal(repeated.retryAllowed, false);
    assert.deepEqual(f.calls, calls);
    assert.equal(f.calls.imap, 0);
  });
}

test('accepted SMTP result and persisted outcome identify the immutable wire and Sent MIME', { timeout: 10000 }, async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'homepl-smtp-message-id-'));
  const wire = [], sent = [];
  const smtp = new SMTPServer({
    secure: false, logger: false, disabledCommands: ['STARTTLS'],
    allowInsecureAuth: true,
    onAuth(_auth, _session, callback) { callback(null, { user: 'synthetic' }); },
    onData(stream, _session, callback) {
      const chunks = [];
      stream.on('data', chunk => chunks.push(chunk));
      stream.on('end', () => { wire.push(Buffer.concat(chunks)); callback(); });
    },
  });
  t.after(async () => {
    await new Promise(resolve => smtp.server.listening ? smtp.close(resolve) : resolve());
    await rm(dataDir, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => {
    smtp.server.once('error', reject);
    smtp.listen(0, '127.0.0.1', resolve);
  });
  const ctx = await createContext({
    dataDir,
    getAccount: async () => ({ email: 'sender@example.invalid', imap: { host: 'fixture.invalid', port: 993 }, smtp: { host: 'fixture.invalid', port: 465 }, folders: { sent: 'Sent' } }),
    getPassword: async () => 'synthetic-password',
    smtpFactory: settings => nodemailer.createTransport({
      ...settings, host: '127.0.0.1', port: smtp.server.address().port,
      secure: false, ignoreTLS: true,
    }),
    imapFactory: () => ({
      connect: async () => {}, logout: async () => {}, close() {},
      append: async (folder, raw) => {
        assert.equal(folder, 'Sent');
        sent.push(raw);
        return { uid: 1, uidValidity: 1n };
      },
    }),
  });
  const tools = Object.fromEntries(writeTools(ctx).map(tool => [tool.name, args => tool.handler(tool.schema.parse(args))]));
  const prepared = await tools.mail_prepare({ accountId: 'synthetic', to: ['recipient@example.invalid'], subject: 'Synthetic identity', text: 'Synthetic message' });
  const reference = { accountId: 'synthetic', operationId: prepared.operationId };
  const raw = await readFile(prepared.emlPath);
  const expected = (await simpleParser(raw)).messageId;
  const stateBefore = await tools.mail_outbox_status(reference);
  assert.equal(Object.hasOwn(stateBefore, 'messageId'), false, 'existing prepared operations have no separately stored Message-ID');
  const result = await tools.mail_send_prepared(reference);
  assert.equal(result.smtpAccepted, true);
  assert.equal(wire.length, 1);
  assert.equal(sent.length, 1);
  assert.deepEqual(wire[0], raw, 'SMTP transmits the prepared bytes unchanged');
  assert.deepEqual(sent[0], await readFile(prepared.sentEmlPath));
  assert.equal((await simpleParser(wire[0])).messageId, expected);
  assert.equal((await simpleParser(sent[0])).messageId, expected);
  assert.equal(result.messageId, expected);
  const stateAfter = await tools.mail_outbox_status(reference);
  assert.equal(stateAfter.outcome.messageId, expected);
  assert.equal(result.sentCopy.saved, true);
});
