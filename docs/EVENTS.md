# Domain events published by account-service

Source of truth for the schemas: `contracts/avro/*.avsc` (file name = topic name). The service keeps a verified copy in
`src/resources/avro/`; after editing a contract run `pnpm --filter account-service contracts:sync` (a unit test fails if
the copies differ).

## Topics

| Topic | Event | Written when | Key |
|---|---|---|---|
| `account.user.registered.v1` | `UserRegistered` | registration committed | user id |
| `account.user.profile-updated.v1` | `UserProfileUpdated` | display name / bio / locale changed (a no-op patch emits nothing) | user id |
| `account.user.deleted.v1` | `UserDeleted` | account deleted | user id |

Value: Avro in the Confluent wire format (byte `0`, 4-byte schema id, Avro bytes). The schema is registered in Schema
Registry under the subject `<topic>-value` at first publish; the registry enforces BACKWARD compatibility.

Headers on every message: `eventId` (same as the `eventId` field), `eventType`, and, when the request had one,
`trace_id` and a W3C `traceparent` so consumers can continue the trace.

## Delivery guarantees (what consumers may rely on)

- **At least once.** If the service crashes after Kafka acknowledged a batch but before it recorded that fact, the batch
  is sent again. **Consumers must de-duplicate by `eventId`.**
- **Ordered per user.** All events of one user share the key, hence the partition, and the service never publishes two
  events of the same user concurrently. Order across different users is not defined.
- **No loss while Kafka is down.** Events wait in the `outbox_event` table (written in the same transaction as the change
  that caused them); the relay retries with exponential backoff and drains the backlog afterwards.
- **A broken event holds back only its own user.** If an event cannot be encoded (schema violation, registry rejects the
  schema), the relay logs it, counts attempts in `outbox_event.attempts`, and keeps publishing other users' events.

## Changing a schema

Backward-compatible changes only (add a field WITH a default, never remove or retype a field). Anything else needs a new
topic (`...v2`) with both versions published during the migration. Edit the `.avsc`, run `contracts:sync`, and
register nothing by hand: the first publish does it, and the registry rejects an incompatible schema with HTTP 409
(the relay then holds the affected events and logs why).

## Looking at a running system

- `GET http://localhost:8081/management/outbox` (management port, not exposed by the gateway): backlog size, age of the
  oldest unpublished event, relay failure counters.
- `/health/ready` lists `outbox` as a non-critical check: `DOWN` after three consecutive failed publishes or a backlog
  older than two minutes. The service stays in rotation because the API still works.
- Registry: `http://localhost:8085/subjects`. Topics: `docker compose -f infra/docker-compose.yml exec kafka /opt/kafka/bin/kafka-topics.sh --bootstrap-server localhost:9092 --list`.
