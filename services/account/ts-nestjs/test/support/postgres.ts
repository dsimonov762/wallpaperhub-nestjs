import type { AppConfig } from '../../src/config/config.js';

export interface TestDatabase {
  db: AppConfig['db'];
  stop: () => Promise<void>;
}

/**
 * Gives integration tests a real PostgreSQL.
 *  - TEST_DB_URL=postgres://user:pass@host:port/dbname  -> use that server (handy without Docker / in CI)
 *  - otherwise: start a throw-away container with Testcontainers (needs Docker Desktop running)
 */
export async function startTestDatabase(): Promise<TestDatabase> {
  const url = process.env.TEST_DB_URL;
  if (url) {
    const u = new URL(url);
    return {
      db: {
        host: u.hostname,
        port: Number(u.port || 5432),
        name: u.pathname.slice(1),
        user: decodeURIComponent(u.username),
        password: decodeURIComponent(u.password),
        poolMax: 10,
        migrateOnStartup: false,
      },
      stop: async () => {},
    };
  }

  const { PostgreSqlContainer } = await import('@testcontainers/postgresql');
  const container = await new PostgreSqlContainer(
    'postgres:18.6-trixie',
  ).start();
  return {
    db: {
      host: container.getHost(),
      port: container.getPort(),
      name: container.getDatabase(),
      user: container.getUsername(),
      password: container.getPassword(),
      poolMax: 10,
      migrateOnStartup: false,
    },
    stop: async () => {
      await container.stop();
    },
  };
}
