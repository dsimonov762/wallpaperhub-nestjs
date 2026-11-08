// A tiny certificate authority for DEVELOPMENT AND TESTS ONLY (Node's crypto can verify certificates but cannot
// create them, so this uses @peculiar/x509 on top of Node's WebCrypto). ECDSA P-256, no files, no openssl needed.
//
// Real environments get their certificates from real infrastructure (cert-manager, Vault, a service mesh, your cloud);
// see docs/TLS.md.
import 'reflect-metadata';
import { randomBytes, webcrypto } from 'node:crypto';
import * as x509 from '@peculiar/x509';

x509.cryptoProvider.set(webcrypto);

const ALGORITHM = { name: 'ECDSA', namedCurve: 'P-256', hash: 'SHA-256' };
const DAY_MS = 86_400_000;

const toPem = (label, der) => {
  const base64 = Buffer.from(der).toString('base64').match(/.{1,64}/g).join('\n');
  return `-----BEGIN ${label}-----\n${base64}\n-----END ${label}-----\n`;
};
const privateKeyPem = async (key) => toPem('PRIVATE KEY', await webcrypto.subtle.exportKey('pkcs8', key));
const serial = () => `01${randomBytes(15).toString('hex')}`;

/** Creates a certificate authority. Returns { certPem, keyPem, ...internals needed to issue certificates }. */
export async function createCa({ commonName = 'Wallpaper Hub Dev CA', days = 3650, notBefore, notAfter } = {}) {
  const keys = await webcrypto.subtle.generateKey(ALGORITHM, true, ['sign', 'verify']);
  const from = notBefore ?? new Date(Date.now() - 60_000);
  const cert = await x509.X509CertificateGenerator.create({
    serialNumber: serial(),
    subject: `CN=${commonName}`,
    issuer: `CN=${commonName}`,
    notBefore: from,
    notAfter: notAfter ?? new Date(from.getTime() + days * DAY_MS),
    signingAlgorithm: ALGORITHM,
    publicKey: keys.publicKey,
    signingKey: keys.privateKey,
    extensions: [
      new x509.BasicConstraintsExtension(true, 0, true),
      new x509.KeyUsagesExtension(x509.KeyUsageFlags.keyCertSign | x509.KeyUsageFlags.cRLSign, true),
      await x509.SubjectKeyIdentifierExtension.create(keys.publicKey, false),
    ],
  });
  return { certPem: cert.toString('pem'), keyPem: await privateKeyPem(keys.privateKey), subject: cert.subject, cert, keys };
}

/**
 * Issues a leaf certificate signed by `ca`. `usage` is 'server' or 'client'.
 * Clients are identified by their common name (and SAN), which is what GRPC_TLS_ALLOWED_CLIENTS lists.
 */
export async function issueCertificate({ ca, commonName, usage, dnsNames = [], ipAddresses = [], days = 825, notBefore, notAfter }) {
  const keys = await webcrypto.subtle.generateKey(ALGORITHM, true, ['sign', 'verify']);
  const from = notBefore ?? new Date(Date.now() - 60_000);
  const names = [...dnsNames.map((value) => ({ type: 'dns', value })), ...ipAddresses.map((value) => ({ type: 'ip', value }))];
  const extensions = [
    new x509.BasicConstraintsExtension(false, undefined, true),
    new x509.KeyUsagesExtension(x509.KeyUsageFlags.digitalSignature, true),
    new x509.ExtendedKeyUsageExtension([usage === 'server' ? x509.ExtendedKeyUsage.serverAuth : x509.ExtendedKeyUsage.clientAuth], false),
    await x509.SubjectKeyIdentifierExtension.create(keys.publicKey, false),
    await x509.AuthorityKeyIdentifierExtension.create(ca.cert, false),
  ];
  if (names.length > 0) extensions.push(new x509.SubjectAlternativeNameExtension(names, false));
  const cert = await x509.X509CertificateGenerator.create({
    serialNumber: serial(),
    subject: `CN=${commonName}`,
    issuer: ca.cert.subject,
    notBefore: from,
    notAfter: notAfter ?? new Date(from.getTime() + days * DAY_MS),
    signingAlgorithm: ALGORITHM,
    publicKey: keys.publicKey,
    signingKey: ca.keys.privateKey,
    extensions,
  });
  return { certPem: cert.toString('pem'), keyPem: await privateKeyPem(keys.privateKey) };
}
