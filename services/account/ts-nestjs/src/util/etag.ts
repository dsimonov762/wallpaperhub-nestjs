import { ValidationException } from '../domain/exceptions/app.exception.js';

/** Entity version -> strong ETag header value: 3 -> "3" */
export const etagOf = (version: number): string => `"${version}"`;

/**
 * Parses an If-Match header into a version number. Accepts "3", W/"3" and 3.
 * Missing or malformed values are a client error (we never guess).
 */
export function parseIfMatch(header: string | string[] | undefined): number {
  const raw = Array.isArray(header) ? header[0] : header;
  const match = raw ? /^(?:W\/)?"?(\d{1,9})"?$/.exec(raw.trim()) : null;
  if (!match)
    throw new ValidationException([
      { field: 'If-Match', code: raw ? 'Invalid' : 'NotBlank' },
    ]);
  return Number(match[1]);
}
