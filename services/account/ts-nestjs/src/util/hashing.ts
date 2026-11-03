import { createHash } from 'node:crypto';

export const sha256Hex = (input: string | Uint8Array): string =>
  createHash('sha256').update(input).digest('hex');
