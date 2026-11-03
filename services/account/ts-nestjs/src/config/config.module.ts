import { Global, Module } from '@nestjs/common';
import { type AppConfig, loadConfig } from './config.js';

/** Injection token for the typed configuration object. */
export const APP_CONFIG = Symbol('APP_CONFIG');

@Global()
@Module({
  providers: [
    { provide: APP_CONFIG, useFactory: (): AppConfig => loadConfig() },
  ],
  exports: [APP_CONFIG],
})
export class ConfigModule {}
