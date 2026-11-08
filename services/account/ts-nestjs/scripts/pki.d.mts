export interface Ca {
  certPem: string;
  keyPem: string;
  subject: string;
  cert: unknown;
  keys: unknown;
}
export interface Leaf {
  certPem: string;
  keyPem: string;
}
export function createCa(options?: { commonName?: string; days?: number; notBefore?: Date; notAfter?: Date }): Promise<Ca>;
export function issueCertificate(options: {
  ca: Ca;
  commonName: string;
  usage: 'server' | 'client';
  dnsNames?: string[];
  ipAddresses?: string[];
  days?: number;
  notBefore?: Date;
  notAfter?: Date;
}): Promise<Leaf>;
