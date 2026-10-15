import test from 'node:test';
import assert from 'node:assert/strict';
import tls from 'node:tls';
import { getMailTlsOptions } from '../src/tls.js';

test('mail trust preserves Node defaults and extra roots, adds OS roots and deduplicates', t => {
  const calls = [];
  t.mock.method(tls, 'getCACertificates', type => {
    calls.push(type);
    return type === 'default' ? ['bundled-root', 'extra-root', 'shared-root'] : ['system-root', 'shared-root'];
  });
  assert.deepEqual(getMailTlsOptions(), {
    ca: ['bundled-root', 'extra-root', 'shared-root', 'system-root'],
    rejectUnauthorized: true, minVersion: 'TLSv1.2',
  });
  assert.deepEqual(calls, ['default', 'system']);
});

test('empty OS store retains existing trusted roots', t => {
  t.mock.method(tls, 'getCACertificates', type => type === 'default' ? ['bundled-root'] : []);
  assert.deepEqual(getMailTlsOptions().ca, ['bundled-root']);
});

test('unsupported Node gives an actionable code instead of claiming OS trust', t => {
  const original = tls.getCACertificates;
  tls.getCACertificates = undefined;
  t.after(() => { tls.getCACertificates = original; });
  assert.throws(getMailTlsOptions, { code: 'TLS_CA_UNSUPPORTED' });
});

test('certificate-store errors are sanitized and never disable verification', t => {
  t.mock.method(tls, 'getCACertificates', () => { throw new Error('PRIVATE_OS_STORE_DETAILS'); });
  assert.throws(getMailTlsOptions, error => {
    assert.equal(error.code, 'TLS_CA_UNAVAILABLE');
    assert.doesNotMatch(error.message, /PRIVATE_OS_STORE_DETAILS/);
    return true;
  });
});
