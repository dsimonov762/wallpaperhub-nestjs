import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AuthGuard } from './auth.guard.js';
import { TokenVerifier } from './token-verifier.js';
import { WhoAmIController } from './whoami.controller.js';

@Module({
  controllers: [WhoAmIController],
  providers: [TokenVerifier, { provide: APP_GUARD, useClass: AuthGuard }],
  exports: [TokenVerifier],
})
export class SecurityModule {}
