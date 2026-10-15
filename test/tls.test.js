import test from 'node:test';
import assert from 'node:assert/strict';
import tls from 'node:tls';
import { assertSupportedNodeVersion, getMailTlsOptions } from '../src/tls.js';

test('runtime baseline excludes Windows file-identity inconsistencies in earlier Node releases', () => {
  for (const version of ['20.20.0', '22.15.0', '22.18.0', '23.11.0', '24.0.0', '24.5.0']) {
    assert.throws(() => assertSupportedNodeVersion(version), { code: 'NODE_UNSUPPORTED' });
  }
  for (const version of ['22.19.0', '22.23.3', '24.6.0', '24.19.0', '26.5.0']) {
    assert.doesNotThrow(() => assertSupportedNodeVersion(version));
  }
});

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
