export interface TestRedis {
  url: string;
  stop: () => Promise<void>;
}

/**
 * A real Redis for integration tests.
 *  - TEST_REDIS_URL=redis://host:port  -> use that server
 *  - otherwise: throw-away container via Testcontainers (needs Docker Desktop running)
 */
export async function startTestRedis(): Promise<TestRedis> {
  if (process.env.TEST_REDIS_URL)
    return { url: process.env.TEST_REDIS_URL, stop: async () => {} };
  const { GenericContainer, Wait } = await import('testcontainers');
  const container = await new GenericContainer('redis:8.8.3-trixie')
    .withExposedPorts(6379)
    .withWaitStrategy(Wait.forLogMessage(/Ready to accept connections/))
    .start();
  return {
    url: `redis://${container.getHost()}:${container.getMappedPort(6379)}`,
    stop: async () => {
      await container.stop();
    },
  };
}
