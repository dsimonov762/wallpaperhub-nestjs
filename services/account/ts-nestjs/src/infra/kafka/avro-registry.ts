import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import avro from 'avsc';

/**
 * Avro + Confluent Schema Registry (README 4.3). Wire format of every message value:
 *
 *   byte 0        magic byte 0
 *   bytes 1..4    schema id (big endian) as assigned by the registry
 *   bytes 5..     the Avro binary payload
 *
 * Consumers read the id, fetch the schema once, and decode. Schemas are registered at publish time under the
 * subject `<topic>-value` (the registry's default naming strategy) and checked there for compatibility.
 */

/** The event itself is wrong for its schema (or has no schema): retrying cannot help. */
export class PermanentEncodingError extends Error {
  override name = 'PermanentEncodingError';
}

/** The registry could not be reached or failed: retry later. */
export class RegistryUnavailableError extends Error {
  override name = 'RegistryUnavailableError';
}

const SCHEMAS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'resources',
  'avro',
);
const CONTENT_TYPE = 'application/vnd.schemaregistry.v1+json';

export function loadSchemas(dir = SCHEMAS_DIR): Map<string, avro.Type> {
  const out = new Map<string, avro.Type>();
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.avsc'))) {
    const topic = file.slice(0, -'.avsc'.length); // file name == topic name
    out.set(
      topic,
      avro.Type.forSchema(JSON.parse(readFileSync(join(dir, file), 'utf8')), {
        wrapUnions: 'auto',
      }),
    );
  }
  return out;
}

export class AvroRegistry {
  private readonly schemas: Map<string, avro.Type>;
  private readonly ids = new Map<string, Promise<number>>();
  private readonly decoders = new Map<number, Promise<avro.Type>>();

  constructor(
    private readonly registryUrl: string,
    private readonly timeoutMs = 5000,
    schemasDir?: string,
  ) {
    this.schemas = loadSchemas(schemasDir);
  }

  topics(): string[] {
    return [...this.schemas.keys()];
  }

  async encode(topic: string, payload: unknown): Promise<Buffer> {
    const type = this.schemas.get(topic);
    if (!type)
      throw new PermanentEncodingError(
        `no Avro schema is defined for topic "${topic}"`,
      );

    const problems: string[] = [];
    if (
      !type.isValid(payload, {
        errorHook: (path) => problems.push(path.join('.') || '(root)'),
      })
    ) {
      throw new PermanentEncodingError(
        `payload does not match the schema of "${topic}" at: ${problems.join(', ')}`,
      );
    }

    const id = await this.schemaId(topic, type);
    const header = Buffer.alloc(5);
    header.writeUInt8(0, 0);
    header.writeUInt32BE(id, 1);
    return Buffer.concat([header, type.toBuffer(payload)]);
  }

  /** For consumers and tests: decode a message value produced by `encode`. */
  async decode(message: Buffer): Promise<unknown> {
    if (message.length < 5 || message.readUInt8(0) !== 0) {
      throw new PermanentEncodingError('not a Confluent-framed Avro message');
    }
    const type = await this.decoderFor(message.readUInt32BE(1));
    return type.fromBuffer(message.subarray(5));
  }

  // ---- registry plumbing ----------------------------------------------------------------------

  /** One registration per topic per process (single flight); a failure is NOT cached, so the next call retries. */
  private schemaId(topic: string, type: avro.Type): Promise<number> {
    let id = this.ids.get(topic);
    if (!id) {
      id = this.register(`${topic}-value`, type).catch((err: unknown) => {
        this.ids.delete(topic);
        throw err;
      });
      this.ids.set(topic, id);
    }
    return id;
  }

  private async register(subject: string, type: avro.Type): Promise<number> {
    const res = await this.call(
      `/subjects/${encodeURIComponent(subject)}/versions`,
      {
        method: 'POST',
        headers: { 'content-type': CONTENT_TYPE },
        body: JSON.stringify({ schema: JSON.stringify(type.schema()) }),
      },
    );
    if (res.status === 200) return ((await res.json()) as { id: number }).id;
    // 409 = incompatible with the registered versions, 422 = invalid schema: both need a human, not a retry.
    if (res.status === 409 || res.status === 422) {
      const detail =
        ((await res.json().catch(() => ({}))) as { message?: string })
          .message ?? '';
      throw new PermanentEncodingError(
        `registry rejected the schema for "${subject}" (HTTP ${res.status}) ${detail}`,
      );
    }
    throw new RegistryUnavailableError(
      `registry answered HTTP ${res.status} for subject "${subject}"`,
    );
  }

  private decoderFor(id: number): Promise<avro.Type> {
    let type = this.decoders.get(id);
    if (!type) {
      type = this.call(`/schemas/ids/${id}`, { method: 'GET' })
        .then(async (res) => {
          if (res.status !== 200)
            throw new RegistryUnavailableError(
              `registry answered HTTP ${res.status} for schema ${id}`,
            );
          const { schema } = (await res.json()) as { schema: string };
          return avro.Type.forSchema(JSON.parse(schema), {
            wrapUnions: 'auto',
          });
        })
        .catch((err: unknown) => {
          this.decoders.delete(id);
          throw err;
        });
      this.decoders.set(id, type);
    }
    return type;
  }

  private async call(path: string, init: RequestInit): Promise<Response> {
    try {
      return await fetch(`${this.registryUrl}${path}`, {
        ...init,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new RegistryUnavailableError(
        `schema registry unreachable: ${(err as Error).message}`,
      );
    }
  }
}
