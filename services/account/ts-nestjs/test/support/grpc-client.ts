import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The canonical contract, NOT the service's copy: tests consume the API exactly like another service would. */
const PROTO = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
  '..',
  'contracts',
  'proto',
  'account',
  'v1',
  'account.proto',
);

export const GRPC_STATUS = grpc.status;

export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });
}

export interface AccountClient {
  unary<T = any>(
    method: string,
    request: object,
    token?: string,
    metadata?: Record<string, string>,
  ): Promise<T>;
  stream<T = any>(
    method: string,
    request: object,
    token?: string,
  ): Promise<T[]>;
  /** Starts a stream and lets the caller cancel it after the first message. */
  openStream(
    method: string,
    request: object,
    token?: string,
  ): grpc.ClientReadableStream<any>;
  close(): void;
}

export interface ClientTls {
  /** PEM of the authority the client trusts for the SERVER certificate (omit: the system roots). */
  ca?: string;
  /** PEM client certificate and key, for mutual TLS. */
  cert?: string;
  key?: string;
  /** Pretend the server is called this (to test host name verification). */
  serverName?: string;
}

export function accountClient(address: string, tls?: ClientTls): AccountClient {
  const definition = protoLoader.loadSync(PROTO, {
    keepCase: false,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
  });
  const pkg = grpc.loadPackageDefinition(definition) as any;
  const credentials = tls
    ? grpc.credentials.createSsl(
        tls.ca ? Buffer.from(tls.ca) : null,
        tls.key ? Buffer.from(tls.key) : null,
        tls.cert ? Buffer.from(tls.cert) : null,
      )
    : grpc.credentials.createInsecure();
  const client = new pkg.wallpaperhub.account.v1.AccountService(
    address,
    credentials,
    tls?.serverName ? { 'grpc.ssl_target_name_override': tls.serverName } : {},
  );

  const md = (token?: string, extra: Record<string, string> = {}) => {
    const metadata = new grpc.Metadata();
    if (token) metadata.set('authorization', `Bearer ${token}`);
    for (const [k, v] of Object.entries(extra)) metadata.set(k, v);
    return metadata;
  };
  const deadline = () => new Date(Date.now() + 10_000);

  return {
    unary: (method, request, token, extra) =>
      new Promise((resolve, reject) =>
        client[method](
          request,
          md(token, extra),
          { deadline: deadline() },
          (err: grpc.ServiceError | null, res: any) =>
            err ? reject(err) : resolve(res),
        ),
      ),
    stream: (method, request, token) =>
      new Promise((resolve, reject) => {
        const call = client[method](request, md(token), {
          deadline: deadline(),
        }) as grpc.ClientReadableStream<any>;
        const out: any[] = [];
        call.on('data', (m) => out.push(m));
        call.on('error', reject);
        call.on('end', () => resolve(out));
      }),
    openStream: (method, request, token) =>
      client[method](request, md(token), { deadline: deadline() }),
    close: () => client.close(),
  };
}
