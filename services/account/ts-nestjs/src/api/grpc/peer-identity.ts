/** Who is on the other end of an mTLS connection, according to the certificate they presented (already verified against our CA). */
export interface PeerIdentity {
  commonName?: string;
  dnsNames: string[];
}

interface AuthContextLike {
  sslPeerCertificate?: { subject?: { CN?: string }; subjectaltname?: string };
}

/** Reads the identity from a gRPC server call (`call.getAuthContext()`); undefined when the call has no client certificate. */
export function peerIdentity(call: unknown): PeerIdentity | undefined {
  const context = (
    call as { getAuthContext?: () => AuthContextLike } | undefined
  )?.getAuthContext?.();
  const cert = context?.sslPeerCertificate;
  if (!cert) return undefined;
  const dnsNames = (cert.subjectaltname ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.startsWith('DNS:'))
    .map((s) => s.slice(4));
  return { commonName: cert.subject?.CN, dnsNames };
}

/** Is this peer on the allowlist? An empty allowlist means "any client certificate our CA signed". */
export function isAllowedPeer(
  peer: PeerIdentity | undefined,
  allowed: string[],
): boolean {
  if (allowed.length === 0) return true;
  if (!peer) return false;
  return (
    allowed.includes(peer.commonName ?? '') ||
    peer.dnsNames.some((name) => allowed.includes(name))
  );
}
