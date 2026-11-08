import 'reflect-metadata';
import { ConfigError, loadConfig } from './config/config.js';
import { loadDotenv } from './config/load-dotenv.js';
import { createLogger } from './infra/logger.js';
import { createDataSource } from './repository/data-source.js';

/**
 * Separate `migrate` command (README section 12): `pnpm migrate`.
 * Applies pending, forward-only migrations and exits. Safe to run repeatedly.
 */
async function main(): Promise<void> {
  loadDotenv();
  const config = loadConfig();
  const log = createLogger({ ...config.log, pretty: config.log.pretty });
  const dataSource = createDataSource({
    ...config.db,
    migrateOnStartup: false,
  });
  await dataSource.initialize();
  try {
    const applied = await dataSource.runMigrations({ transaction: 'each' });
    log.info(
      { applied: applied.map((m) => m.name) },
      applied.length ? 'migrations applied' : 'database already up to date',
    );
  } finally {
    await dataSource.destroy();
  }
}

main().catch((e) => {
  console.error(e instanceof ConfigError ? e.message : e);
  process.exit(1);
});
