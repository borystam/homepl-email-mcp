import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));

test('generated config preserves custom data location and read-only access in JSON and TOML', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'homepl-config-output-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { stdout, stderr } = await run(process.execPath, [cli, 'config', '--read-only'], { env: { ...process.env, HOME_MAIL_DATA_DIR: directory } });
  assert.equal(stderr, '');
  const [json, toml] = stdout.split('\nCodex TOML entry');
  const config = JSON.parse(json).mcpServers['homepl-email'];
  assert.deepEqual(config.args, [cli, 'serve', '--read-only']);
  assert.deepEqual(config.env, { HOME_MAIL_DATA_DIR: directory });
  assert.ok(toml.includes(`HOME_MAIL_DATA_DIR = ${JSON.stringify(directory)}`));
  assert.ok(toml.includes(JSON.stringify(config.args)));
});

test('misspelled access-control option fails instead of silently starting with writes enabled', async () => {
  await assert.rejects(run(process.execPath, [cli, 'serve', '--readonly']), error => error.code === 1);
});
