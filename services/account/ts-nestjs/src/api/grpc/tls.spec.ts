import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { createCa, issueCertificate } from '../../../scripts/pki.mjs';
import { loadServerTls, TlsConfigError } from './tls.js';
import { isAllowedPeer, peerIdentity } from './peer-identity.js';

const dir = mkdtempSync(join(tmpdir(), 'tls-spec-'));
const file = (name: string, content: string) => {
  const path = join(dir, name);
  writeFileSync(path, content);
  return path;
};

let ca: Awaited<ReturnType<typeof createCa>>;
let good: { cert: string; key: string; ca: string };

beforeAll(async () => {
  ca = await createCa();
  const server = await issueCertificate({
    ca,
    commonName: 'account-service',
    usage: 'server',
    dnsNames: ['localhost'],
  });
  good = {
    cert: file('server.crt', server.certPem),
    key: file('server.key', server.keyPem),
    ca: file('ca.crt', ca.certPem),
  };
});

const tls = (
  over: Partial<{
    mode: 'tls' | 'mtls';
    certFile: string;
    keyFile: string;
    caFile: string;
  }> = {},
) => ({
  mode: 'mtls' as const,
  certFile: good.cert,
  keyFile: good.key,
  caFile: good.ca,
  allowedClients: ['catalog-svc'],
  ...over,
});

describe('loadServerTls', () => {
  it('returns nothing when TLS is off', () => {
    expect(
      loadServerTls({
        mode: 'off',
        certFile: '',
        keyFile: '',
        caFile: '',
        allowedClients: [],
      }),
    ).toBeUndefined();
  });

  it('accepts a valid certificate, key and CA, and summarizes them for monitoring', () => {
    const material = loadServerTls(tls())!;
    expect(material.credentials).toBeDefined();
    expect(material.info.mode).toBe('mtls');
    expect(material.info.certificate).toMatchObject({
      subject: 'CN=account-service',
    });
    expect(material.info.certificate!.daysLeft).toBeGreaterThan(800);
    expect(material.info.clientCa!.subject).toContain('Wallpaper Hub Dev CA');
    expect(material.info.allowedClients).toEqual(['catalog-svc']);
  });

  it('needs no CA in tls mode', () => {
    expect(
      loadServerTls(tls({ mode: 'tls', caFile: '' }))!.info.clientCa,
    ).toBeUndefined();
  });

  it('names the setting and the file when a file is missing', () => {
    expect(() =>
      loadServerTls(tls({ certFile: '/nope/server.crt' })),
    ).toThrowError(/GRPC_TLS_CERT_FILE: cannot read "\/nope\/server.crt"/);
    expect(() => loadServerTls(tls({ caFile: '/nope/ca.crt' }))).toThrowError(
      /GRPC_TLS_CA_FILE: cannot read/,
    );
  });

  it('rejects files that are not PEM certificates or keys', () => {
    const junk = file('junk.pem', 'this is not a certificate');
    expect(() => loadServerTls(tls({ certFile: junk }))).toThrowError(
      /GRPC_TLS_CERT_FILE: ".*junk.pem" is not a PEM certificate/,
    );
    expect(() => loadServerTls(tls({ keyFile: junk }))).toThrowError(
      /GRPC_TLS_KEY_FILE: .* is not a readable PEM private key/,
    );
    expect(() => loadServerTls(tls({ caFile: junk }))).toThrowError(
      /GRPC_TLS_CA_FILE: .* is not a PEM certificate/,
    );
  });

  it('rejects a private key that belongs to a different certificate', async () => {
    const other = await issueCertificate({
      ca,
      commonName: 'someone-else',
      usage: 'server',
    });
    expect(() =>
      loadServerTls(tls({ keyFile: file('other.key', other.keyPem) })),
    ).toThrowError(/is not the private key of the certificate/);
  });

  it('rejects expired and not-yet-valid certificates, saying when', async () => {
    const day = 86_400_000;
    const expired = await issueCertificate({
      ca,
      commonName: 'old',
      usage: 'server',
      notBefore: new Date(Date.now() - 20 * day),
      notAfter: new Date(Date.now() - day),
    });
    const future = await issueCertificate({
      ca,
      commonName: 'future',
      usage: 'server',
      notBefore: new Date(Date.now() + 5 * day),
      notAfter: new Date(Date.now() + 50 * day),
    });
    expect(() =>
      loadServerTls(
        tls({
          certFile: file('expired.crt', expired.certPem),
          keyFile: file('expired.key', expired.keyPem),
        }),
      ),
    ).toThrowError(/expired on/);
    expect(() =>
      loadServerTls(
        tls({
          certFile: file('future.crt', future.certPem),
          keyFile: file('future.key', future.keyPem),
        }),
      ),
    ).toThrowError(/not valid before/);
    expect(() =>
      loadServerTls(
        tls({
          certFile: file('expired2.crt', expired.certPem),
          keyFile: file('expired2.key', expired.keyPem),
        }),
      ),
    ).toThrowError(TlsConfigError);
  });

  it('rejects an expired client CA', async () => {
    const day = 86_400_000;
    const oldCa = await createCa({
      notBefore: new Date(Date.now() - 20 * day),
      notAfter: new Date(Date.now() - day),
    });
    expect(() =>
      loadServerTls(tls({ caFile: file('oldca.crt', oldCa.certPem) })),
    ).toThrowError(/GRPC_TLS_CA_FILE: certificate .* expired on/);
  });

  it('reports few days left so the caller can warn', async () => {
    const soon = await issueCertificate({
      ca,
      commonName: 'soon',
      usage: 'server',
      notAfter: new Date(Date.now() + 5 * 86_400_000),
    });
    const info = loadServerTls(
      tls({
        certFile: file('soon.crt', soon.certPem),
        keyFile: file('soon.key', soon.keyPem),
      }),
    )!.info;
    expect(info.certificate!.daysLeft).toBeLessThan(6);
  });
});

describe('client allowlist', () => {
  const call = (cn: string, san = '') => ({
    getAuthContext: () => ({
      sslPeerCertificate: { subject: { CN: cn }, subjectaltname: san },
    }),
  });

  it('reads the identity from the certificate presented on the call', () => {
    expect(
      peerIdentity(
        call(
          'catalog-svc',
          'DNS:catalog-svc, DNS:catalog.internal, IP Address:10.0.0.5',
        ),
      ),
    ).toEqual({
      commonName: 'catalog-svc',
      dnsNames: ['catalog-svc', 'catalog.internal'],
    });
    expect(peerIdentity({ getAuthContext: () => ({}) })).toBeUndefined(); // no client certificate
    expect(peerIdentity(undefined)).toBeUndefined();
    expect(peerIdentity({})).toBeUndefined();
  });

  it('allows everyone with a certificate when the allowlist is empty, and nobody without one when it is not', () => {
    expect(isAllowedPeer({ commonName: 'x', dnsNames: [] }, [])).toBe(true);
    expect(isAllowedPeer(undefined, [])).toBe(true);
    expect(isAllowedPeer(undefined, ['catalog-svc'])).toBe(false);
  });

  it('matches on common name or any DNS name', () => {
    const allowed = ['catalog-svc', 'notification-svc'];
    expect(
      isAllowedPeer({ commonName: 'catalog-svc', dnsNames: [] }, allowed),
    ).toBe(true);
    expect(
      isAllowedPeer(
        { commonName: 'whatever', dnsNames: ['notification-svc'] },
        allowed,
      ),
    ).toBe(true);
    expect(
      isAllowedPeer(
        { commonName: 'rogue-svc', dnsNames: ['rogue-svc'] },
        allowed,
      ),
    ).toBe(false);
    expect(
      isAllowedPeer({ commonName: 'catalog-svc-evil', dnsNames: [] }, allowed),
    ).toBe(false); // exact match, not a prefix
  });
});
