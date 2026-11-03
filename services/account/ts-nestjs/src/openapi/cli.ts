import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse, stringify } from 'yaml';
import { diffAgainstContract } from './contract-diff.js';
import { GLOBAL_PREFIX, generateOpenApiFromCode } from './preview-document.js';

/**
 *   node dist/openapi/cli.js generate   writes build/openapi/account.generated.yaml
 *   node dist/openapi/cli.js check      compares the generated document with contracts/openapi/account.yaml (exit 1 on any difference)
 * Neither needs a database, Redis, Kafka or Keycloak.
 */
const here = dirname(fileURLToPath(import.meta.url));
const CONTRACT = join(
  here,
  '..',
  '..',
  '..',
  '..',
  '..',
  'contracts',
  'openapi',
  'account.yaml',
);
const GENERATED = join(
  here,
  '..',
  '..',
  'build',
  'openapi',
  'account.generated.yaml',
);

const command = process.argv[2];
if (command !== 'generate' && command !== 'check') {
  console.error('usage: node dist/openapi/cli.js <generate|check>');
  process.exit(2);
}

const generated = await generateOpenApiFromCode();
mkdirSync(dirname(GENERATED), { recursive: true });
writeFileSync(GENERATED, stringify(generated));

if (command === 'generate') {
  console.log(`generated ${GENERATED}`);
} else {
  const issues = diffAgainstContract(
    parse(readFileSync(CONTRACT, 'utf8')),
    generated,
    { pathPrefix: GLOBAL_PREFIX },
  );
  if (issues.length === 0) {
    console.log('OK: the code matches contracts/openapi/account.yaml');
  } else {
    console.error(
      `The code does not match contracts/openapi/account.yaml (${issues.length} difference${issues.length === 1 ? '' : 's'}):`,
    );
    for (const issue of issues) console.error(`  - ${issue}`);
    console.error(
      `\nGenerated document: ${GENERATED}\nFix the code, or change the contract first if the change is intended.`,
    );
    process.exit(1);
  }
}
