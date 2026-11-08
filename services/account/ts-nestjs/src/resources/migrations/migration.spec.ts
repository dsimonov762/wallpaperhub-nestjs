import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { INIT_ACCOUNT_SCHEMA_SQL } from './1761264000000-init-account-schema.js';
import { OUTBOX_NOTIFY_SQL } from './1761350400000-outbox-notify.js';

const squash = (s: string) =>
  s
    .split('\n')
    .filter((l) => !l.trim().startsWith('--'))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();

describe('schema parity', () => {
  it('all migrations together equal contracts/db-schema/account.sql', () => {
    const file = join(
      dirname(fileURLToPath(import.meta.url)),
      '..',
      '..',
      '..',
      '..',
      '..',
      '..',
      'contracts',
      'db-schema',
      'account.sql',
    );
    expect(
      squash(`${INIT_ACCOUNT_SCHEMA_SQL}
${OUTBOX_NOTIFY_SQL}`),
    ).toBe(squash(readFileSync(file, 'utf8')));
  });
});
