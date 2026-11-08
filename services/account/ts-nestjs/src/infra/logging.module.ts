import { Global, Module } from '@nestjs/common';
import type { AppConfig } from '../config/config.js';
import { APP_CONFIG } from '../config/config.module.js';
import { createLogger, LOGGER } from './logger.js';

/** Makes the pino logger injectable everywhere with `@Inject(LOGGER)`. */
@Global()
@Module({
  providers: [
    {
      provide: LOGGER,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => createLogger(config.log),
    },
  ],
  exports: [LOGGER],
})
export class LoggingModule {}
