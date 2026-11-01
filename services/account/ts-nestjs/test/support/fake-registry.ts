import Fastify, { type FastifyInstance } from 'fastify';

/** A tiny Confluent-Schema-Registry look-alike: register a schema per subject, fetch it back by id. */
export interface FakeRegistry {
  url: string;
  /** Schema registrations received (subject names), to assert "registered once". */
  registrations: string[];
  /** Make every call answer this HTTP status (e.g. 503), or `undefined` to behave normally. */
  forceStatus?: number;
  /** Subjects starting with this prefix answer 409 (incompatible schema). */
  rejectPrefix?: string;
  close: () => Promise<void>;
}

export async function startFakeRegistry(): Promise<FakeRegistry> {
  const server: FastifyInstance = Fastify();
  const byId = new Map<number, string>();
  const idOf = new Map<string, number>();
  let next = 100;

  server.addContentTypeParser(
    'application/vnd.schemaregistry.v1+json',
    { parseAs: 'string' },
    (_req, body, done) => {
      try {
        done(null, JSON.parse(body as string));
      } catch (e) {
        done(e as Error);
      }
    },
  );

  const registry: FakeRegistry = {
    url: '',
    registrations: [],
    close: async () => {
      await server.close();
    },
  };

  server.post('/subjects/:subject/versions', async (req, reply) => {
    if (registry.forceStatus)
      return reply.status(registry.forceStatus).send({ message: 'forced' });
    const subject = decodeURIComponent(
      (req.params as { subject: string }).subject,
    );
    registry.registrations.push(subject);
    if (registry.rejectPrefix && subject.startsWith(registry.rejectPrefix)) {
      return reply.status(409).send({ message: 'incompatible schema' });
    }
    const schema = (req.body as { schema: string }).schema;
    let id = idOf.get(subject);
    if (id === undefined) {
      id = next++;
      idOf.set(subject, id);
      byId.set(id, schema);
    }
    return { id };
  });

  server.get('/schemas/ids/:id', async (req, reply) => {
    if (registry.forceStatus)
      return reply.status(registry.forceStatus).send({ message: 'forced' });
    const schema = byId.get(Number((req.params as { id: string }).id));
    return schema
      ? { schema }
      : reply.status(404).send({ message: 'not found' });
  });

  registry.url = await server.listen({ host: '127.0.0.1', port: 0 });
  return registry;
}
