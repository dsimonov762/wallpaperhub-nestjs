import { type MicroserviceOptions, Transport } from '@nestjs/microservices';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AppConfig } from '../../config/config.js';
import { GrpcTlsStatus } from './tls-status.js';
import { loadServerTls, type TlsInfo } from './tls.js';

export const PROTO_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'resources',
  'proto',
  'account',
  'v1',
  'account.proto',
);

/**
 * Makes the HTTP application ALSO a gRPC server (a "hybrid" app): same modules, same DI container, same guard,
 * filter and interceptors, second port. Call `await app.startAllMicroservices()` afterwards to start listening.
 */
export function attachGrpc(
  app: NestFastifyApplication,
  config: AppConfig,
): TlsInfo | undefined {
  // Validates the certificate files first (TlsConfigError names the file and the problem); undefined = plain text.
  const tls = loadServerTls(config.grpc.tls);
  app.get(GrpcTlsStatus).set(tls?.info);

  app.connectMicroservice<MicroserviceOptions>(
    {
      transport: Transport.GRPC,
      options: {
        package: 'wallpaperhub.account.v1',
        protoPath: PROTO_PATH,
        url: `${config.http.host}:${config.http.grpcPort}`,
        // camelCase fields in JavaScript, 64-bit integers as strings, enums as names, absent fields as defaults.
        loader: {
          keepCase: false,
          longs: String,
          enums: String,
          defaults: true,
          oneofs: true,
        },
        maxReceiveMessageLength: 1024 * 1024,
        ...(tls ? { credentials: tls.credentials } : {}),
      },
    },
    // Inherit the application's global guard, filter and interceptors: without this the gRPC side would run
    // with NONE of them (no authentication!).
    { inheritAppConfig: true },
  );
  return tls?.info;
}
