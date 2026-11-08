import { ServerCredentials } from '@grpc/grpc-js';
import { createPrivateKey, X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { AppConfig } from '../../config/config.js';

type TlsConfig = AppConfig['grpc']['tls'];

export const EXPIRY_WARNING_DAYS = 30;

/** A certificate problem with a message a human can act on. */
export class TlsConfigError extends Error {
  override name = 'TlsConfigError';
}

export interface CertificateSummary {
  subject: string;
  issuer: string;
  validFrom: string;
  validTo: string;
  daysLeft: number;
}

export interface TlsInfo {
  mode: TlsConfig['mode'];
  certificate?: CertificateSummary;
  clientCa?: CertificateSummary;
  allowedClients: string[];
}

export interface TlsMaterial {
  credentials: ServerCredentials;
  info: TlsInfo;
}

const summarize = (cert: X509Certificate, now: Date): CertificateSummary => ({
  subject: cert.subject.replace(/\n/g, ', '),
  issuer: cert.issuer.replace(/\n/g, ', '),
  validFrom: new Date(cert.validFrom).toISOString(),
  validTo: new Date(cert.validTo).toISOString(),
  daysLeft: Math.floor(
    (new Date(cert.validTo).getTime() - now.getTime()) / 86_400_000,
  ),
});

function read(setting: string, path: string): Buffer {
  try {
    return readFileSync(path);
  } catch (e) {
    throw new TlsConfigError(
      `${setting}: cannot read "${path}" (${(e as NodeJS.ErrnoException).code ?? (e as Error).message})`,
    );
  }
}

function parseCertificate(
  setting: string,
  path: string,
  pem: Buffer,
): X509Certificate {
  try {
    return new X509Certificate(pem);
  } catch {
    throw new TlsConfigError(`${setting}: "${path}" is not a PEM certificate`);
  }
}

function checkValidity(
  setting: string,
  path: string,
  cert: X509Certificate,
  now: Date,
): void {
  if (now < new Date(cert.validFrom))
    throw new TlsConfigError(
      `${setting}: certificate "${path}" is not valid before ${new Date(cert.validFrom).toISOString()}`,
    );
  if (now > new Date(cert.validTo))
    throw new TlsConfigError(
      `${setting}: certificate "${path}" expired on ${new Date(cert.validTo).toISOString()}`,
    );
}

/**
 * Reads and VALIDATES the gRPC TLS files, then builds the server credentials. Every mistake that would otherwise
 * show up as an obscure handshake failure in production is caught here, at startup, with the file named:
 * unreadable or non-PEM files, a private key that does not belong to the certificate, expired certificates.
 * Returns undefined when TLS is off.
 */
export function loadServerTls(
  tls: TlsConfig,
  now = new Date(),
): TlsMaterial | undefined {
  if (tls.mode === 'off') return undefined;

  const certPem = read('GRPC_TLS_CERT_FILE', tls.certFile);
  const keyPem = read('GRPC_TLS_KEY_FILE', tls.keyFile);
  const cert = parseCertificate('GRPC_TLS_CERT_FILE', tls.certFile, certPem);
  checkValidity('GRPC_TLS_CERT_FILE', tls.certFile, cert, now);

  let key;
  try {
    key = createPrivateKey(keyPem);
  } catch {
    throw new TlsConfigError(
      `GRPC_TLS_KEY_FILE: "${tls.keyFile}" is not a readable PEM private key (encrypted keys are not supported)`,
    );
  }
  if (!cert.checkPrivateKey(key)) {
    throw new TlsConfigError(
      `GRPC_TLS_KEY_FILE: "${tls.keyFile}" is not the private key of the certificate "${tls.certFile}"`,
    );
  }

  const info: TlsInfo = {
    mode: tls.mode,
    certificate: summarize(cert, now),
    allowedClients: tls.allowedClients,
  };
  let caPem: Buffer | null = null;
  if (tls.mode === 'mtls') {
    caPem = read('GRPC_TLS_CA_FILE', tls.caFile);
    const ca = parseCertificate('GRPC_TLS_CA_FILE', tls.caFile, caPem);
    checkValidity('GRPC_TLS_CA_FILE', tls.caFile, ca, now);
    info.clientCa = summarize(ca, now);
  }

  return {
    credentials: ServerCredentials.createSsl(
      caPem,
      [{ cert_chain: certPem, private_key: keyPem }],
      tls.mode === 'mtls',
    ),
    info,
  };
}
