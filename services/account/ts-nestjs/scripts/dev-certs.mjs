#!/usr/bin/env node
// Creates DEVELOPMENT certificates for the gRPC port, in infra/tls/dev/ (git-ignored):
//
//   ca.crt / ca.key                    the development certificate authority (trust ca.crt, keep ca.key private)
//   server.crt / server.key            the account-service server (valid for localhost, 127.0.0.1, ::1, account-service)
//   catalog-svc.crt / .key             a client identity for the catalog service
//   notification-svc.crt / .key        a client identity for the notification service
//
//   pnpm tls:dev-certs            create them, or keep the existing ones while they are valid for 30+ more days
//   pnpm tls:dev-certs -- --force   create new ones
//
// Private keys are written world-readable on purpose, so the non-root user inside the container can read the mounted
// files. That is acceptable ONLY because these certificates exist for development and are trusted by nothing real.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { X509Certificate } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCa, issueCertificate } from './pki.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const out = process.env.TLS_DEV_DIR ?? join(here, '..', '..', '..', '..', 'infra', 'tls', 'dev');
const force = process.argv.includes('--force');
const MIN_DAYS_LEFT = 30;
const FILES = ['ca.crt', 'ca.key', 'server.crt', 'server.key', 'catalog-svc.crt', 'catalog-svc.key', 'notification-svc.crt', 'notification-svc.key'];

function stillGood() {
  if (!FILES.every((f) => existsSync(join(out, f)))) return false;
  try {
    return FILES.filter((f) => f.endsWith('.crt')).every((f) => {
      const days = (new Date(new X509Certificate(readFileSync(join(out, f))).validTo).getTime() - Date.now()) / 86_400_000;
      return days > MIN_DAYS_LEFT;
    });
  } catch {
    return false;
  }
}

if (!force && stillGood()) {
  console.log(`development certificates in ${out} are still valid, nothing to do (use --force to replace them)`);
  process.exit(0);
}

mkdirSync(out, { recursive: true });
const write = (name, content) => writeFileSync(join(out, name), content, { mode: 0o644 });

const ca = await createCa();
write('ca.crt', ca.certPem);
write('ca.key', ca.keyPem);

const server = await issueCertificate({ ca, commonName: 'account-service', usage: 'server', dnsNames: ['localhost', 'account-service'], ipAddresses: ['127.0.0.1', '::1'] });
write('server.crt', server.certPem);
write('server.key', server.keyPem);

for (const client of ['catalog-svc', 'notification-svc']) {
  const leaf = await issueCertificate({ ca, commonName: client, usage: 'client', dnsNames: [client] });
  write(`${client}.crt`, leaf.certPem);
  write(`${client}.key`, leaf.keyPem);
}

console.log(`created development certificates in ${out}:\n  ${FILES.join('\n  ')}`);
