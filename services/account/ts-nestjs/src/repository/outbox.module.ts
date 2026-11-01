import { Module } from '@nestjs/common';
import { OutboxRepository } from './outbox.repository.js';

@Module({ providers: [OutboxRepository], exports: [OutboxRepository] })
export class OutboxModule {}
