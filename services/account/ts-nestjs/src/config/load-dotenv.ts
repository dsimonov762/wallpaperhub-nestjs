import { existsSync } from 'node:fs';

/**
 * Local convenience: if a `.env` file exists in the working directory, load it into process.env.
 * Real environment variables always win (Node does not overwrite variables that are already set),
 * so containers and CI are unaffected.
 */
export function loadDotenv(path = '.env'): void {
  if (existsSync(path)) process.loadEnvFile(path);
}
