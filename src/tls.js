import tls from 'node:tls';

export const tlsErrorDescriptions = Object.freeze({
  TLS_CA_UNSUPPORTED: 'System certificate trust requires Node.js 22.15 or newer on the 22.x line, or Node.js 24 or newer. Update the native Node executable used by setup and the MCP client.',
  TLS_CA_UNAVAILABLE: 'Trusted certificates could not be loaded from Node.js and the operating system. Check the local certificate store and restart the connector; TLS verification remains required.',
});

export function getMailTlsOptions() {
  if (typeof tls.getCACertificates !== 'function') {
    throw Object.assign(new Error(tlsErrorDescriptions.TLS_CA_UNSUPPORTED), { code: 'TLS_CA_UNSUPPORTED' });
  }
  try {
    // An explicit ca replaces Node's defaults. Keep those (including configured
    // extra CAs) and add OS-trusted roots, e.g. an installed mail-scanning CA.
    const ca = [...new Set([...tls.getCACertificates('default'), ...tls.getCACertificates('system')])];
    return { ca, rejectUnauthorized: true, minVersion: 'TLSv1.2' };
  } catch {
    throw Object.assign(new Error(tlsErrorDescriptions.TLS_CA_UNAVAILABLE), { code: 'TLS_CA_UNAVAILABLE' });
  }
}
