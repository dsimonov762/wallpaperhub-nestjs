#!/usr/bin/env node
// Developer tool: call the account-service gRPC API from the command line (no extra software needed).
//
//   node scripts/grpc-call.mjs GetUser --id <uuid> --token <service-account-jwt>
//   node scripts/grpc-call.mjs GetUsersByIds --ids <uuid>,<uuid> --token <jwt>
//   node scripts/grpc-call.mjs ListUsersUpdatedSince --since 2026-01-01T00:00:00Z --token <jwt> [--addr localhost:9090]
//
// Or pass the request as JSON (careful with quotes in Windows PowerShell, prefer the flags above):
//   node scripts/grpc-call.mjs GetUser '{"id":"<uuid>"}' --token <jwt>
//
// The token must belong to a service account (realm role "internal"), e.g. from the client-credentials grant of
// catalog-svc: see docs/GETTING-STARTED.md. The contract is read from contracts/proto/account/v1/account.proto.
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const [method, ...rest] = process.argv.slice(2);
const json = rest[0] && !rest[0].startsWith('--') ? rest.shift() : '{}';
const flags = rest;
const flag = (name, fallback) => {
  const i = flags.indexOf(`--${name}`);
  return i >= 0 ? flags[i + 1] : fallback;
};
if (!method) {
  console.error('usage: node scripts/grpc-call.mjs <GetUser|GetUsersByIds|ListUsersUpdatedSince> [json] [--token JWT] [--addr host:port]');
  process.exit(2);
}

const proto = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'contracts', 'proto', 'account', 'v1', 'account.proto');
const definition = protoLoader.loadSync(proto, { keepCase: false, longs: String, enums: String, defaults: true, oneofs: true });
const Service = grpc.loadPackageDefinition(definition).wallpaperhub.account.v1.AccountService;
const client = new Service(flag('addr', 'localhost:9090'), grpc.credentials.createInsecure());

const metadata = new grpc.Metadata();
if (flag('token')) metadata.set('authorization', `Bearer ${flag('token')}`);
const options = { deadline: new Date(Date.now() + 15_000) };

const fail = (err) => {
  console.error(`${grpc.status[err.code] ?? err.code}: ${err.details ?? err.message}`);
  const fields = err.metadata?.get('x-field-errors')[0];
  if (fields) console.error(`field errors: ${fields}`);
  process.exit(1);
};

if (!client[method]) fail({ code: grpc.status.UNIMPLEMENTED, details: `unknown method "${method}"` });
const request = JSON.parse(json);
if (flag('id')) request.id = flag('id');
if (flag('ids')) request.ids = flag('ids').split(',');
if (flag('since')) {
  const ms = Date.parse(flag('since'));
  if (Number.isNaN(ms)) fail({ code: grpc.status.INVALID_ARGUMENT, details: `--since is not a date: ${flag('since')}` });
  request.since = { seconds: String(Math.floor(ms / 1000)), nanos: (ms % 1000) * 1e6 };
}
if (method === 'ListUsersUpdatedSince') {
  const call = client[method](request, metadata, options);
  call.on('data', (user) => console.log(JSON.stringify(user)));
  call.on('error', fail);
  call.on('end', () => client.close());
} else {
  client[method](request, metadata, options, (err, response) => {
    if (err) return fail(err);
    console.log(JSON.stringify(response, null, 2));
    client.close();
  });
}
