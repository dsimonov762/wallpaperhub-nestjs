/**
 * Compares an OpenAPI document generated from code with the hand-written contract (contracts/openapi/*.yaml).
 *
 * Both documents are first reduced to the same canonical form, so harmless differences vanish:
 *   - $refs are resolved (schema names do not matter, structure does)
 *   - `type: [string, 'null']` (3.1) equals `type: string` + `nullable: true` (3.0, what Nest generates)
 *   - header names are case-insensitive, property order is irrelevant, descriptions/examples/tags/summaries are ignored
 *
 * What IS compared, per operation: parameters, request body, response status codes (with body media types and
 * schemas, and header names), and security. Operations the contract marks `x-implemented: false` are planned and
 * allowed to be absent from the code.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = Record<string, any>;

const METHODS = ['get', 'put', 'post', 'delete', 'patch', 'options', 'head'];
const SCHEMA_SCALARS = [
  'format',
  'pattern',
  'minLength',
  'maxLength',
  'minimum',
  'maximum',
  'default',
] as const;

interface NormResponse {
  content: Record<string, unknown>;
  headers: Record<string, unknown>;
}
interface NormOperation {
  planned: boolean;
  parameters: Record<string, { required: boolean; schema: unknown }>;
  body?: { required: boolean; content: Record<string, unknown> };
  responses: Record<string, NormResponse>;
  security: string[];
}

function resolve(doc: Json, node: any): any {
  let current = node;
  for (
    let hops = 0;
    current && typeof current === 'object' && '$ref' in current;
    hops++
  ) {
    if (hops > 20) throw new Error(`$ref chain too long at ${current.$ref}`);
    const target = String(current.$ref)
      .replace(/^#\//, '')
      .split('/')
      .reduce<any>(
        (acc, part) => acc?.[part.replace(/~1/g, '/').replace(/~0/g, '~')],
        doc,
      );
    if (target === undefined)
      throw new Error(`unresolvable $ref ${current.$ref}`);
    current = target;
  }
  return current;
}

function schema(doc: Json, raw: any, seen: string[] = []): unknown {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw === 'object' && '$ref' in raw) {
    if (seen.includes(raw.$ref))
      return { recursive: String(raw.$ref).split('/').pop() };
    return schema(doc, resolve(doc, raw), [...seen, raw.$ref]);
  }
  const out: Json = {};
  if (Array.isArray(raw.type)) {
    const types = raw.type.filter((t: string) => t !== 'null');
    if (types.length !== raw.type.length) out.nullable = true;
    out.type = types.length === 1 ? types[0] : [...types].sort();
  } else if (raw.type !== undefined) {
    out.type = raw.type;
  }
  if (raw.nullable) out.nullable = true;
  for (const key of SCHEMA_SCALARS)
    if (raw[key] !== undefined) out[key] = raw[key];
  if (raw.readOnly) out.readOnly = true;
  if (raw.writeOnly) out.writeOnly = true;
  if (Array.isArray(raw.enum)) out.enum = [...raw.enum].map(String).sort();
  if (raw.items) out.items = schema(doc, raw.items, seen);
  if (raw.properties) {
    out.properties = Object.fromEntries(
      Object.entries(raw.properties as Json)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, value]) => [name, schema(doc, value, seen)]),
    );
  }
  if (Array.isArray(raw.required) && raw.required.length > 0)
    out.required = [...raw.required].sort();
  return out;
}

function content(doc: Json, raw: any): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries((raw ?? {}) as Json)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([media, value]) => [
        media.split(';')[0]!.trim().toLowerCase(),
        schema(doc, (value as Json)?.schema),
      ]),
  );
}

export function normalize(
  doc: Json,
  stripPrefix = '',
): Map<string, NormOperation> {
  const out = new Map<string, NormOperation>();
  for (const [rawPath, rawItem] of Object.entries((doc.paths ?? {}) as Json)) {
    const path =
      (stripPrefix && rawPath.startsWith(stripPrefix)
        ? rawPath.slice(stripPrefix.length)
        : rawPath
      ).replace(/(.)\/$/, '$1') || '/';
    const item = resolve(doc, rawItem) as Json;
    for (const method of METHODS) {
      const op = item[method] as Json | undefined;
      if (!op) continue;

      const parameters: NormOperation['parameters'] = {};
      for (const raw of [
        ...(item.parameters ?? []),
        ...(op.parameters ?? []),
      ]) {
        const p = resolve(doc, raw) as Json;
        const name = p.in === 'header' ? String(p.name).toLowerCase() : p.name;
        parameters[`${p.in}:${name}`] = {
          required: p.in === 'path' ? true : Boolean(p.required),
          schema: schema(doc, p.schema),
        };
      }

      const responses: NormOperation['responses'] = {};
      for (const [status, rawResponse] of Object.entries(
        (op.responses ?? {}) as Json,
      )) {
        if (status === 'default') continue;
        const r = resolve(doc, rawResponse) as Json;
        responses[status] = {
          content: content(doc, r.content),
          headers: Object.fromEntries(
            Object.entries((r.headers ?? {}) as Json)
              .sort(([a], [b]) =>
                a.toLowerCase().localeCompare(b.toLowerCase()),
              )
              .map(([name, h]) => [
                name.toLowerCase(),
                schema(doc, resolve(doc, h).schema),
              ]),
          ),
        };
      }

      const requirements: Json[] = op.security ?? doc.security ?? [];
      const body = op.requestBody
        ? (resolve(doc, op.requestBody) as Json)
        : undefined;
      out.set(`${method.toUpperCase()} ${path}`, {
        planned: op['x-implemented'] === false,
        parameters,
        body: body
          ? {
              required: Boolean(body.required),
              content: content(doc, body.content),
            }
          : undefined,
        responses,
        security: requirements.flatMap((r) => Object.keys(r)).sort(),
      });
    }
  }
  return out;
}

/** Walks two canonical values and reports every difference with its path. */
function compare(a: unknown, b: unknown, path: string, issues: string[]): void {
  if (JSON.stringify(a) === JSON.stringify(b)) return;
  const isObject = (v: unknown): v is Json =>
    typeof v === 'object' && v !== null && !Array.isArray(v);
  if (isObject(a) && isObject(b)) {
    for (const key of [
      ...new Set([...Object.keys(a), ...Object.keys(b)]),
    ].sort()) {
      if (!(key in a))
        issues.push(
          `${path}.${key}: only in the code (${JSON.stringify(b[key])})`,
        );
      else if (!(key in b))
        issues.push(
          `${path}.${key}: only in the contract (${JSON.stringify(a[key])})`,
        );
      else compare(a[key], b[key], `${path}.${key}`, issues);
    }
    return;
  }
  issues.push(
    `${path}: contract ${JSON.stringify(a)}, code ${JSON.stringify(b)}`,
  );
}

/** Returns human-readable problems; an empty list means the code matches the contract. */
export function diffAgainstContract(
  contract: Json,
  generated: Json,
  options: { pathPrefix?: string } = {},
): string[] {
  const expected = normalize(contract);
  const actual = normalize(
    generated,
    options.pathPrefix ? `/${options.pathPrefix.replace(/^\/|\/$/g, '')}` : '',
  );
  const issues: string[] = [];

  for (const key of [
    ...new Set([...expected.keys(), ...actual.keys()]),
  ].sort()) {
    const want = expected.get(key);
    const have = actual.get(key);
    if (want && !have) {
      if (!want.planned)
        issues.push(
          `${key}: is in the contract but the code does not serve it (if it is planned, mark it x-implemented: false)`,
        );
      continue;
    }
    if (!want && have) {
      issues.push(
        `${key}: is served by the code but missing from the contract`,
      );
      continue;
    }
    if (!want || !have) continue;
    if (want.planned) {
      issues.push(
        `${key}: the contract says x-implemented: false but the code serves it: remove the flag`,
      );
      continue;
    }

    compare(want.parameters, have.parameters, `${key} parameters`, issues);
    compare(want.body ?? null, have.body ?? null, `${key} requestBody`, issues);
    compare(want.security, have.security, `${key} security`, issues);
    const statuses = [
      ...new Set([
        ...Object.keys(want.responses),
        ...Object.keys(have.responses),
      ]),
    ].sort();
    for (const status of statuses) {
      if (!(status in want.responses))
        issues.push(`${key} response ${status}: only in the code`);
      else if (!(status in have.responses))
        issues.push(`${key} response ${status}: only in the contract`);
      else
        compare(
          want.responses[status],
          have.responses[status],
          `${key} response ${status}`,
          issues,
        );
    }
  }
  return issues;
}
