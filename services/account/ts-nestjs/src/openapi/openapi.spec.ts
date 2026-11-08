import SwaggerParser from '@apidevtools/swagger-parser';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { ProfilePatchDto } from '../dto/profile-patch.dto.js';
import { RegistrationRequestDto } from '../dto/registration-request.dto.js';
import { diffAgainstContract } from './contract-diff.js';
import { GLOBAL_PREFIX, generateOpenApiFromCode } from './preview-document.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
const contractFile = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
  '..',
  'contracts',
  'openapi',
  'account.yaml',
);
const contract = parse(readFileSync(contractFile, 'utf8'));
let generated: any;
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

beforeAll(async () => {
  generated = await generateOpenApiFromCode(); // no database, Redis, Kafka or Keycloak needed
});

describe('the generated OpenAPI document', () => {
  it('is a valid OpenAPI document, and so is the contract', async () => {
    await expect(
      SwaggerParser.validate(clone(generated)),
    ).resolves.toBeDefined();
    await expect(SwaggerParser.validate(contractFile)).resolves.toBeDefined();
  });

  it('matches contracts/openapi/account.yaml (operations, parameters, bodies, responses, headers, security)', () => {
    expect(
      diffAgainstContract(contract, generated, { pathPrefix: GLOBAL_PREFIX }),
    ).toEqual([]);
  });

  it('requires a bearer token everywhere except the public registration', () => {
    const open: string[] = [];
    for (const [path, item] of Object.entries<any>(generated.paths)) {
      for (const [method, op] of Object.entries<any>(item)) {
        if (!op.security?.some((s: any) => 'bearerAuth' in s))
          open.push(`${method.toUpperCase()} ${path}`);
      }
    }
    expect(open).toEqual([`POST /${GLOBAL_PREFIX}/registrations`]);
  });

  describe('the comparison has teeth: it notices when the code drifts from the contract', () => {
    const issues = (mutate: (doc: any) => void) => {
      const copy = clone(generated);
      mutate(copy);
      return diffAgainstContract(contract, copy, {
        pathPrefix: GLOBAL_PREFIX,
      }).join('\n');
    };

    it('a removed endpoint', () => {
      expect(
        issues((d) => delete d.paths[`/${GLOBAL_PREFIX}/whoami`]),
      ).toContain(
        'GET /whoami: is in the contract but the code does not serve it',
      );
    });
    it('a new, undocumented endpoint', () => {
      expect(
        issues(
          (d) =>
            (d.paths[`/${GLOBAL_PREFIX}/debug`] = {
              get: { responses: { '200': { description: '' } } },
            }),
        ),
      ).toContain(
        'GET /debug: is served by the code but missing from the contract',
      );
    });
    it('a lost response code', () => {
      expect(
        issues(
          (d) =>
            delete d.paths[`/${GLOBAL_PREFIX}/users/me`].get.responses['404'],
        ),
      ).toContain('GET /users/me response 404: only in the contract');
    });
    it('a loosened validation limit', () => {
      expect(
        issues(
          (d) =>
            (d.components.schemas.RegistrationRequestDto.properties.username.maxLength = 500),
        ),
      ).toContain('maxLength: contract 64, code 500');
    });
    it('a field that stopped being required', () => {
      expect(
        issues(
          (d) =>
            (d.components.schemas.UserDto.required =
              d.components.schemas.UserDto.required.filter(
                (f: string) => f !== 'version',
              )),
        ),
      ).toContain('required');
    });
    it('a removed security requirement', () => {
      expect(
        issues((d) => delete d.paths[`/${GLOBAL_PREFIX}/users`].get.security),
      ).toContain('GET /users security');
    });
  });
});

/**
 * The documented limits must be the limits the validators really enforce. Documentation and validation are
 * written twice (OpenAPI decorators and class-validator decorators); these tests keep the two honest.
 */
describe('documented constraints are enforced by the validators', () => {
  const valid = async (
    Dto: new () => object,
    payload: Record<string, unknown>,
  ) =>
    (
      await validate(plainToInstance(Dto, payload), {
        whitelist: true,
        forbidNonWhitelisted: true,
      })
    ).length === 0;

  const cases: [string, new () => object, Record<string, unknown>][] = [
    [
      'RegistrationRequestDto',
      RegistrationRequestDto,
      {
        username: 'alice_01',
        email: 'alice@example.com',
        password: 'correct-horse-battery',
        displayName: 'Alice',
      },
    ],
    ['ProfilePatchDto', ProfilePatchDto, { displayName: 'Alice' }],
  ];

  describe.each(cases)('%s', (name, Dto, sample) => {
    const schemaOf = () => generated.components.schemas[name];

    it('the sample payload is valid', async () => {
      expect(await valid(Dto, sample)).toBe(true);
    });

    it('required properties are required, optional ones are optional', async () => {
      const { required = [], properties } = schemaOf();
      for (const field of required) {
        const { [field]: _omitted, ...rest } = sample;
        expect(
          await valid(Dto, rest),
          `${name}.${field} documented as required`,
        ).toBe(false);
      }
      for (const field of Object.keys(properties).filter(
        (f) => !required.includes(f),
      )) {
        expect(
          await valid(Dto, {
            ...sample,
            [field]: field === 'locale' ? 'de' : 'x',
          }),
          `${name}.${field} documented as optional`,
        ).toBe(true);
      }
    });

    it('string length limits are exactly the documented ones', async () => {
      for (const [field, prop] of Object.entries<any>(schemaOf().properties)) {
        if (prop.type !== 'string' || prop.format === 'email' || prop.enum)
          continue; // email: IsEmail has stricter local-part rules
        const at = (n: number) => ({ ...sample, [field]: 'a'.repeat(n) });
        if (prop.minLength !== undefined) {
          expect(
            await valid(Dto, at(prop.minLength)),
            `${name}.${field} accepts minLength`,
          ).toBe(true);
          if (prop.minLength > 0)
            expect(
              await valid(Dto, at(prop.minLength - 1)),
              `${name}.${field} rejects minLength-1`,
            ).toBe(false);
        }
        if (prop.maxLength !== undefined) {
          expect(
            await valid(Dto, at(prop.maxLength)),
            `${name}.${field} accepts maxLength`,
          ).toBe(true);
          expect(
            await valid(Dto, at(prop.maxLength + 1)),
            `${name}.${field} rejects maxLength+1`,
          ).toBe(false);
        }
      }
    });

    it('enums accept exactly the documented values; patterns match the sample and reject an obvious violation', async () => {
      for (const [field, prop] of Object.entries<any>(schemaOf().properties)) {
        if (prop.enum) {
          for (const value of prop.enum)
            expect(
              await valid(Dto, { ...sample, [field]: value }),
              `${name}.${field}=${value}`,
            ).toBe(true);
          expect(
            await valid(Dto, { ...sample, [field]: 'zz' }),
            `${name}.${field} rejects an undocumented value`,
          ).toBe(false);
        }
        if (prop.pattern) {
          expect(
            new RegExp(prop.pattern).test(String(sample[field])),
            `${name}.${field} sample matches its pattern`,
          ).toBe(true);
          expect(
            await valid(Dto, { ...sample, [field]: 'not valid!' }),
            `${name}.${field} rejects a pattern violation`,
          ).toBe(false);
        }
      }
    });
  });

  it('pagination parameters: limits and defaults are the documented ones', async () => {
    const { PageQueryDto } = await import('../dto/page-query.dto.js');
    const params: any[] =
      generated.paths[`/${GLOBAL_PREFIX}/users`].get.parameters;
    const doc = (n: string) => params.find((p) => p.name === n).schema;
    expect(doc('page')).toMatchObject({ minimum: 0, default: 0 });
    expect(doc('size')).toMatchObject({
      minimum: 1,
      maximum: 100,
      default: 20,
    });
    const ok = async (q: Record<string, unknown>) =>
      (await validate(plainToInstance(PageQueryDto, q))).length === 0;
    expect(await ok({ page: doc('page').minimum })).toBe(true);
    expect(await ok({ page: doc('page').minimum - 1 })).toBe(false);
    expect(await ok({ size: doc('size').minimum })).toBe(true);
    expect(await ok({ size: doc('size').minimum - 1 })).toBe(false);
    expect(await ok({ size: doc('size').maximum })).toBe(true);
    expect(await ok({ size: doc('size').maximum + 1 })).toBe(false);
    const defaults = new PageQueryDto();
    expect([defaults.page, defaults.size]).toEqual([
      doc('page').default,
      doc('size').default,
    ]);
  });
});
