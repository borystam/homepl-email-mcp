#!/usr/bin/env node
// GitHub Windows CI only: temporarily trust a unique synthetic root in the
// current user's certificate store. Never touches mail accounts or credentials.
// Fresh workers avoid Node's cached system certificate list between stages.
import assert from 'node:assert/strict';
import { X509Certificate, randomUUID } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import tls from 'node:tls';

function run(file, args, options, label = file) {
  process.stdout.write(`[system-ca] ${label}: started\n`);
  return new Promise((resolve, reject) => {
    const child = execFile(file, args, options, (error, stdout, stderr) => {
      if (!error) {
        process.stdout.write(`[system-ca] ${label}: completed\n`);
        return resolve({ stdout, stderr });
      }
      // This script is restricted to disposable CI and only handles synthetic
      // data. Bound diagnostics so the next failure identifies the exact tool.
      process.stderr.write(`[system-ca] ${JSON.stringify({
        label, code: error.code, killed: error.killed, signal: error.signal,
        stdout: String(stdout).slice(-2000), stderr: String(stderr).slice(-2000),
      })}\n`);
      reject(new Error(`${label} failed (code ${error.code ?? 'none'}, signal ${error.signal ?? 'none'})`));
    });
    // execFile creates an open stdin pipe. Native CLI tools must receive EOF;
    // otherwise PowerShell can wait for further input instead of terminating.
    child.stdin?.on('error', error => { if (error.code !== 'EPIPE') reject(error); });
    child.stdin?.end();
  });
}
const trustErrors = new Set([
  'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
]);

async function worker() {
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk;
    assert.ok(Buffer.byteLength(input) <= 4096);
  }
  const { port, mode, expected } = JSON.parse(input);
  assert.ok(Number.isInteger(port) && port > 0 && port <= 65535);
  assert.ok(['default', 'system', 'wrong-host'].includes(mode));
  assert.ok(['accepted', 'untrusted', 'wrong-host'].includes(expected));
  const options = mode === 'default'
    ? { rejectUnauthorized: true, minVersion: 'TLSv1.2' }
    : (await import('../src/tls.js')).getMailTlsOptions();
  assert.equal(options.rejectUnauthorized, true);
  const result = await new Promise((resolve, reject) => {
    const socket = tls.connect({
      ...options, host: '127.0.0.1', port,
      servername: mode === 'wrong-host' ? 'wrong-host.example.invalid' : 'localhost',
    });
    socket.setTimeout(5000, () => socket.destroy(new Error('Synthetic TLS timeout')));
    socket.once('secureConnect', () => {
      if (!socket.authorized) return reject(new Error('Synthetic socket is not authorized'));
      socket.end();
      resolve('accepted');
    });
    socket.once('error', error => {
      if (trustErrors.has(error.code)) resolve('untrusted');
      else if (error.code === 'ERR_TLS_CERT_ALTNAME_INVALID') resolve('wrong-host');
      else reject(new Error('Unexpected synthetic TLS failure'));
    });
  });
  assert.equal(result, expected);
  process.stdout.write('ok\n');
}

function workerEnvironment() {
  // A CI/user Node override must not accidentally enable native trust for the
  // plain Node baseline. Each worker still reads the actual Windows root store.
  const ignored = new Set(['NODE_OPTIONS', 'NODE_USE_SYSTEM_CA', 'NODE_EXTRA_CA_CERTS', 'NODE_TLS_REJECT_UNAUTHORIZED']);
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => !ignored.has(key.toUpperCase())));
}

function runWorker(request) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--worker'], {
      stdio: ['pipe', 'pipe', 'pipe'], env: workerEnvironment(), timeout: 15_000,
    });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.resume();
    child.once('error', reject);
    child.stdin.once('error', reject);
    child.once('close', code => code === 0 && output === 'ok\n'
      ? resolve() : reject(new Error('Synthetic system-CA worker failed')));
    child.stdin.end(JSON.stringify(request));
  });
}

async function updateWindowsRoot(action, certPath, thumbprint) {
  assert.ok(['add', 'remove'].includes(action));
  assert.match(thumbprint, /^[A-F0-9]{40}$/);
  assert.equal(new X509Certificate(await readFile(certPath)).fingerprint.replaceAll(':', ''), thumbprint);
  // X509Store.Add can display an interactive root-trust prompt. Certutil's
  // force flag performs this synthetic CI import without waiting for UI.
  // PowerShell only verifies the exact thumbprint through a read-only store.
  const count = await windowsRootCount(thumbprint, `root:${action}:count-before`);
  if (action === 'add') assert.equal(count, 0, 'Synthetic root unexpectedly exists');
  else if (count === 0) return;
  await run('certutil.exe', ['-user', '-f', action === 'add' ? '-addstore' : '-delstore', 'Root', action === 'add' ? certPath : thumbprint], {
    timeout: 20_000, windowsHide: true,
  }, `root:${action}:certutil`);
  assert.equal(await windowsRootCount(thumbprint, `root:${action}:count-after`), action === 'add' ? 1 : 0, 'Synthetic root-store update failed');
}

async function windowsRootCount(thumbprint, label) {
  assert.match(thumbprint, /^[A-F0-9]{40}$/);
  // Never print or remove unrelated certificates. The thumbprint travels
  // through env rather than becoming executable PowerShell source.
  const command = `
$ErrorActionPreference = 'Stop'
$expected = $env:HOMEPL_SMOKE_CERT_THUMBPRINT
$store = [System.Security.Cryptography.X509Certificates.X509Store]::new('Root', 'CurrentUser')
$store.Open([System.Security.Cryptography.X509Certificates.OpenFlags]::ReadOnly)
try {
  [Console]::WriteLine($store.Certificates.Find([System.Security.Cryptography.X509Certificates.X509FindType]::FindByThumbprint, $expected, $false).Count)
} finally {
  $store.Close()
}
exit 0
`;
  const { stdout } = await run('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')], {
    timeout: 20_000, windowsHide: true,
    env: { ...process.env, HOMEPL_SMOKE_CERT_THUMBPRINT: thumbprint },
  }, label);
  assert.match(stdout.trim(), /^\d+$/);
  return Number(stdout.trim());
}

async function smoke() {
  assert.equal(process.platform, 'win32', 'This smoke test requires Windows');
  assert.equal(process.env.GITHUB_ACTIONS, 'true', 'Run this temporary trust-store test only on an ephemeral GitHub CI runner');
  assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted', 'Do not modify trust on a self-hosted runner');
  const directory = await mkdtemp(join(tmpdir(), 'homepl-system-ca-smoke-'));
  const certPath = join(directory, 'fixture.crt');
  const storeCertPath = join(directory, 'fixture.der');
  const keyPath = join(directory, 'fixture.key');
  const configPath = join(directory, 'openssl.cnf');
  let thumbprint;
  let server;
  let failure;
  let stage = 'synthetic certificate generation';
  const sockets = new Set();
  try {
    await writeFile(configPath, `[req]\nprompt=no\ndistinguished_name=dn\nx509_extensions=extensions\n[dn]\nCN=homepl-system-ca-smoke-${randomUUID()}\n[extensions]\nsubjectAltName=DNS:localhost,IP:127.0.0.1\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,digitalSignature,keyEncipherment,keyCertSign\nextendedKeyUsage=serverAuth\n`, { mode: 0o600 });
    await run('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-sha256', '-nodes', '-days', '1', '-config', configPath, '-keyout', keyPath, '-out', certPath], { timeout: 20_000 });
    // Use DER for the native Windows certificate import.
    await run('openssl', ['x509', '-in', certPath, '-outform', 'DER', '-out', storeCertPath], { timeout: 5000 });
    const [key, cert] = await Promise.all([readFile(keyPath), readFile(certPath)]);
    thumbprint = new X509Certificate(cert).fingerprint.replaceAll(':', '');
    server = tls.createServer({ key, cert, minVersion: 'TLSv1.2' }, socket => socket.end());
    server.on('tlsClientError', () => {});
    server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const port = server.address().port;
    stage = 'untrusted baseline';
    await runWorker({ port, mode: 'system', expected: 'untrusted' });
    stage = 'temporary root installation';
    await updateWindowsRoot('add', storeCertPath, thumbprint);
    stage = 'plain Node still rejects the OS-only root';
    await runWorker({ port, mode: 'default', expected: 'untrusted' });
    stage = 'connector trusts the Windows root';
    await runWorker({ port, mode: 'system', expected: 'accepted' });
    stage = 'hostname validation';
    await runWorker({ port, mode: 'wrong-host', expected: 'wrong-host' });
  } catch (error) {
    process.stderr.write(`[system-ca] ${stage}: ${error.message}\n`);
    failure = stage;
  } finally {
    if (thumbprint) {
      try { await updateWindowsRoot('remove', storeCertPath, thumbprint); }
      catch (error) { process.stderr.write(`[system-ca] cleanup: ${error.message}\n`); failure = 'temporary root cleanup'; }
    }
    if (!failure && server?.listening) {
      try { await runWorker({ port: server.address().port, mode: 'system', expected: 'untrusted' }); }
      catch { failure = 'trust rejection after root removal'; }
    }
    for (const socket of sockets) socket.destroy();
    if (server?.listening) await new Promise(resolve => server.close(resolve));
    try { await rm(directory, { recursive: true, force: true }); }
    catch { failure = 'temporary file cleanup'; }
  }
  if (failure) throw new Error(`Windows system certificate trust smoke failed during ${failure}`);
  process.stdout.write('Windows native certificate trust passed: OS-only root accepted, default Node rejection and hostname validation preserved, exact synthetic root removed.\n');
}

try {
  if (process.argv.length === 3 && process.argv[2] === '--worker') await worker();
  else if (process.argv.length === 2) await smoke();
  else throw new Error('Invalid system-CA smoke arguments');
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
