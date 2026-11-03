/** PII masking for logs (README sections 11 and 12). Never log raw emails or tokens. */

export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@');
  if (at < 1) return '***';
  return `${email[0]}***${email.slice(at)}`;
}

export function maskSecret(value: string): string {
  return value.length <= 8
    ? '***'
    : `${value.slice(0, 4)}***${value.slice(-2)}`;
}

/** pino `redact` paths: removed from every log line, wherever they appear at these paths. */
export const LOG_REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'password',
  '*.password',
  'accessToken',
  'refreshToken',
  '*.accessToken',
  '*.refreshToken',
];
