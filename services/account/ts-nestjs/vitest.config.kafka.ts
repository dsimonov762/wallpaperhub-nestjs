import { defineConfig } from 'vitest/config';

// Needs the docker compose infrastructure running (pnpm infra:up): real Kafka on localhost:9094 and
// Schema Registry on localhost:8085. Override with TEST_KAFKA_BROKERS / TEST_SCHEMA_REGISTRY_URL.
export default defineConfig({
  test: {
    globals: true,
    root: './',
    include: ['test/**/*.kafka-spec.ts'],
    testTimeout: 90_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
});
