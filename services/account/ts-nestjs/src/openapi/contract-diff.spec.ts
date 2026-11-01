import { describe, expect, it } from 'vitest';
import { diffAgainstContract, normalize } from './contract-diff.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
const doc = (
  paths: any,
  components: any = {},
  security: any[] = [{ bearerAuth: [] }],
) => ({ openapi: '3.0.0', security, paths, components });
const op = (over: any = {}) => ({
  responses: {
    '200': {
      description: 'ok',
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: { id: { type: 'string' } },
            required: ['id'],
          },
        },
      },
    },
  },
  ...over,
});

describe('normalize', () => {
  it('resolves $refs, merges path-level parameters, and ignores prose', () => {
    const d = doc(
      {
        '/things/{id}': {
          parameters: [{ $ref: '#/components/parameters/Id' }],
          get: {
            summary: 'whatever',
            responses: { '200': { $ref: '#/components/responses/Ok' } },
          },
        },
      },
      {
        parameters: {
          Id: {
            name: 'id',
            in: 'path',
            required: true,
            schema: { type: 'string', format: 'uuid' },
            description: 'ignored',
          },
        },
        responses: {
          Ok: {
            description: 'ignored',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Thing' },
              },
            },
          },
        },
        schemas: {
          Thing: { type: 'object', properties: { id: { type: 'string' } } },
        },
      },
    );
    const n = normalize(d).get('GET /things/{id}')!;
    expect(n.parameters['path:id']).toEqual({
      required: true,
      schema: { type: 'string', format: 'uuid' },
    });
    expect(n.responses['200']!.content['application/json']).toEqual({
      type: 'object',
      properties: { id: { type: 'string' } },
    });
    expect(n.security).toEqual(['bearerAuth']);
  });

  it('treats 3.1 `type: [string, null]` and 3.0 `nullable: true` as the same', () => {
    const a = doc({
      '/x': {
        get: op({
          responses: {
            '200': {
              description: '',
              content: {
                'application/json': { schema: { type: ['string', 'null'] } },
              },
            },
          },
        }),
      },
    });
    const b = doc({
      '/x': {
        get: op({
          responses: {
            '200': {
              description: '',
              content: {
                'application/json': {
                  schema: { type: 'string', nullable: true },
                },
              },
            },
          },
        }),
      },
    });
    expect(diffAgainstContract(a, b)).toEqual([]);
  });

  it('knows security: per-operation override, global default, and "no security"', () => {
    const d = doc({
      '/open': { get: op({ security: [] }) },
      '/closed': { get: op() },
    });
    expect(normalize(d).get('GET /open')!.security).toEqual([]);
    expect(normalize(d).get('GET /closed')!.security).toEqual(['bearerAuth']);
  });
});

describe('diffAgainstContract', () => {
  const contract = doc({
    '/things': {
      get: op(),
      post: op({
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['name'],
                properties: { name: { type: 'string', maxLength: 10 } },
              },
            },
          },
        },
      }),
    },
  });
  const same = () => JSON.parse(JSON.stringify(contract));

  it('reports nothing for identical documents, and strips the global prefix of generated paths', () => {
    expect(diffAgainstContract(contract, same())).toEqual([]);
    const prefixed = {
      ...same(),
      paths: { '/api/v1/things': same().paths['/things'] },
    };
    expect(
      diffAgainstContract(contract, prefixed, { pathPrefix: 'api/v1' }),
    ).toEqual([]);
  });

  it('reports an operation that is not implemented, unless the contract marks it planned', () => {
    const generated = same();
    delete generated.paths['/things'].post;
    expect(diffAgainstContract(contract, generated)).toEqual([
      expect.stringContaining(
        'POST /things: is in the contract but the code does not serve it',
      ),
    ]);

    const planned = same();
    planned.paths['/things'].post['x-implemented'] = false;
    expect(diffAgainstContract(planned, generated)).toEqual([]);
  });

  it('reports an operation the contract does not know, and a planned operation that exists in code', () => {
    const extra = same();
    extra.paths['/secret'] = { get: op() };
    expect(diffAgainstContract(contract, extra)).toEqual([
      expect.stringContaining(
        'GET /secret: is served by the code but missing from the contract',
      ),
    ]);

    const planned = same();
    planned.paths['/things'].get['x-implemented'] = false;
    expect(diffAgainstContract(planned, same())).toEqual([
      expect.stringContaining('x-implemented: false but the code serves it'),
    ]);
  });

  it('reports response, schema, constraint, parameter and security drift with paths', () => {
    const g = same();
    g.paths['/things'].get.responses['404'] = { description: 'x' };
    g.paths['/things'].post.requestBody.content[
      'application/json'
    ].schema.properties.name.maxLength = 20;
    g.paths['/things'].post.requestBody.content[
      'application/json'
    ].schema.required = [];
    g.paths['/things'].get.parameters = [
      { name: 'q', in: 'query', schema: { type: 'string' } },
    ];
    g.paths['/things'].get.security = [];
    const issues = diffAgainstContract(contract, g).join('\n');
    expect(issues).toContain('GET /things response 404: only in the code');
    expect(issues).toContain(
      'POST /things requestBody.content.application/json.properties.name.maxLength: contract 10, code 20',
    );
    expect(issues).toContain(
      'POST /things requestBody.content.application/json.required: only in the contract',
    );
    expect(issues).toContain(
      'GET /things parameters.query:q: only in the code',
    );
    expect(issues).toContain('GET /things security');
  });

  it('is case-insensitive for header names and ignores descriptions', () => {
    const a = doc({
      '/x': {
        get: op({
          parameters: [
            {
              name: 'If-Match',
              in: 'header',
              required: true,
              description: 'a',
              schema: { type: 'string' },
            },
          ],
        }),
      },
    });
    const b = doc({
      '/x': {
        get: op({
          parameters: [
            {
              name: 'if-match',
              in: 'header',
              required: true,
              description: 'completely different',
              schema: { type: 'string' },
            },
          ],
        }),
      },
    });
    expect(diffAgainstContract(a, b)).toEqual([]);
  });

  it('survives recursive schemas', () => {
    const tree = {
      components: {
        schemas: {
          Node: {
            type: 'object',
            properties: { child: { $ref: '#/components/schemas/Node' } },
          },
        },
      },
    };
    const d = {
      ...doc({
        '/t': {
          get: op({
            responses: {
              '200': {
                description: '',
                content: {
                  'application/json': {
                    schema: { $ref: '#/components/schemas/Node' },
                  },
                },
              },
            },
          }),
        },
      }),
      ...tree,
    };
    expect(diffAgainstContract(d, d)).toEqual([]);
  });
});
