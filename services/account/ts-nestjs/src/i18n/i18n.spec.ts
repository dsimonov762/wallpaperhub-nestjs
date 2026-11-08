import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  I18nService,
  negotiateLocale,
  SUPPORTED_LOCALES,
} from './i18n.service.js';

const here = dirname(fileURLToPath(import.meta.url));
const contractsDir = join(
  here,
  '..',
  '..',
  '..',
  '..',
  '..',
  'contracts',
  'i18n',
);
const bundleDir = join(here, '..', 'resources', 'i18n');

describe('negotiateLocale', () => {
  it.each([
    [undefined, 'en'],
    ['de-DE,de;q=0.9,en;q=0.5', 'de'],
    ['fr-FR,es;q=0.8', 'es'],
    ['fr,ja', 'en'],
    ['en;q=0.1,de;q=0.9', 'de'],
    ['de;q=0', 'en'],
  ])('%s -> %s', (header, expected) => {
    expect(negotiateLocale(header)).toBe(expected);
  });
});

describe('I18nService', () => {
  const i18n = new I18nService();

  it('translates and interpolates', () => {
    expect(i18n.t('validation.NotBlank', 'en', { field: 'Title' })).toBe(
      'Title must not be blank.',
    );
    expect(i18n.t('validation.NotBlank', 'de', { field: 'Titel' })).toBe(
      'Titel darf nicht leer sein.',
    );
    expect(
      i18n.t('problem.rate-limited.detail', 'es', { retryAfter: 30 }),
    ).toContain('30');
  });

  it('falls back to the key when it is unknown', () => {
    expect(i18n.t('no.such.key', 'de')).toBe('no.such.key');
  });
});

describe('shared bundles (contracts/i18n)', () => {
  const read = (dir: string, locale: string) =>
    JSON.parse(readFileSync(join(dir, `${locale}.json`), 'utf8'));

  it('the service copy is identical to contracts/i18n (run `pnpm contracts:sync` if this fails)', () => {
    for (const locale of SUPPORTED_LOCALES) {
      expect(read(bundleDir, locale)).toEqual(read(contractsDir, locale));
    }
  });

  it('every locale has exactly the same keys as English', () => {
    const en = Object.keys(read(contractsDir, 'en')).sort();
    for (const locale of SUPPORTED_LOCALES) {
      expect(Object.keys(read(contractsDir, locale)).sort()).toEqual(en);
    }
  });
});
