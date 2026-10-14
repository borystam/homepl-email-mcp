#!/usr/bin/env node
// CI/operator smoke check. Uses a new synthetic credential and deletes it afterward.
// This does not enumerate, read, or change any existing user credentials.
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
const password = randomBytes(32).toString('base64url');
let entry;
let failure;
try {
  const { AsyncEntry } = await import('@napi-rs/keyring');
  entry = new AsyncEntry('homepl-email-mcp.smoke-test', randomUUID(), { linux: { store: 'secret-service' } });
  assert.equal(await entry.getPassword(), null);
  await entry.setPassword(password);
  assert.equal(await entry.getPassword(), password);
  await entry.setPassword(`${password}-rotated`);
  assert.equal(await entry.getPassword(), `${password}-rotated`);
} catch {
  failure = true;
} finally {
  try {
    if (entry) {
      await entry.deletePassword();
      assert.equal(await entry.getPassword(), null);
    }
  } catch { failure = true; }
}
if (failure) {
  process.stderr.write('Native credential store check failed. Ensure the operating system credential store is available and unlocked.\n');
  process.exitCode = 1;
} else {
  process.stdout.write(`Native credential store set/read/rotate/delete check passed on ${process.platform}.\n`);
}
