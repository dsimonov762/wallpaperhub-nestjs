import { Injectable } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { MessageArgs } from '../domain/exceptions/app.exception.js';

export const SUPPORTED_LOCALES = ['en', 'de', 'es'] as const;
export type Locale = (typeof SUPPORTED_LOCALES)[number];
export const DEFAULT_LOCALE: Locale = 'en';

const bundlesDir = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'resources',
  'i18n',
);

function loadBundles(): Record<Locale, Record<string, string>> {
  const out = {} as Record<Locale, Record<string, string>>;
  for (const locale of SUPPORTED_LOCALES) {
    out[locale] = JSON.parse(
      readFileSync(join(bundlesDir, `${locale}.json`), 'utf8'),
    );
  }
  return out;
}

/**
 * Picks the best supported locale from an `Accept-Language` header
 * ("de-DE,de;q=0.9,en;q=0.5" -> "de"). Falls back to English.
 */
export function negotiateLocale(header: string | undefined): Locale {
  if (!header) return DEFAULT_LOCALE;
  const candidates = header
    .split(',')
    .map((part) => {
      const [tag = '', ...params] = part.trim().split(';');
      const q = params.map((p) => p.trim()).find((p) => p.startsWith('q='));
      return {
        lang: tag.toLowerCase().split('-')[0] ?? '',
        q: q ? Number(q.slice(2)) : 1,
      };
    })
    .filter((c) => c.q > 0 && !Number.isNaN(c.q))
    .sort((a, b) => b.q - a.q);
  for (const c of candidates) {
    const hit = SUPPORTED_LOCALES.find((l) => l === c.lang);
    if (hit) return hit;
  }
  return DEFAULT_LOCALE;
}

@Injectable()
export class I18nService {
  private readonly bundles = loadBundles();

  /** Translates a key; missing keys fall back to English, then to the key itself. */
  t(key: string, locale: Locale, args: MessageArgs = {}): string {
    const template =
      this.bundles[locale][key] ?? this.bundles[DEFAULT_LOCALE][key] ?? key;
    return template.replace(/\{(\w+)\}/g, (whole, name: string) =>
      name in args ? String(args[name]) : whole,
    );
  }

  has(key: string): boolean {
    return key in this.bundles[DEFAULT_LOCALE];
  }
}
