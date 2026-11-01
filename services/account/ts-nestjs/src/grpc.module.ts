import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { AccountGrpcController } from './api/grpc/account.grpc-controller.js';
import { GrpcCallInterceptor } from './api/grpc/grpc-call.interceptor.js';
import { UsersModule } from './users.module.js';

/** The internal gRPC API (README phase 1, step 1.5). The server itself is attached in main.ts (api/grpc/setup-grpc.ts). */
@Module({
  imports: [UsersModule],
  controllers: [AccountGrpcController],
  providers: [{ provide: APP_INTERCEPTOR, useClass: GrpcCallInterceptor }],
})
export class GrpcModule {}
