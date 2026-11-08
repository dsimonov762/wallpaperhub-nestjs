import { Module } from '@nestjs/common';
import { APP_CONFIG } from './config/config.module.js';
import type { AppConfig } from './config/config.js';
import { EventPublisher } from './domain/event-publisher.js';
import { AvroRegistry } from './infra/kafka/avro-registry.js';
import {
  createProducer,
  KAFKA_PRODUCER,
  KafkaEventPublisher,
} from './infra/kafka/kafka-event-publisher.js';
import { JobScheduler, SCHEDULED_JOBS } from './jobs/job-scheduler.js';
import { OutboxCleanupJob } from './jobs/outbox-cleanup.job.js';
import { OutboxMonitor } from './jobs/outbox-monitor.js';
import { OutboxRelay } from './jobs/outbox-relay.js';
import { UserPurgeJob } from './jobs/user-purge.job.js';
import { OutboxModule } from './repository/outbox.module.js';
import { ResilienceModule } from './resilience/resilience.module.js';
import { Clock, SystemClock } from './util/clock.js';

/** Everything that gets events out of the database and keeps the database tidy (README phase 1, step 1.6). */
@Module({
  imports: [OutboxModule, ResilienceModule],
  providers: [
    { provide: Clock, useClass: SystemClock },
    {
      provide: AvroRegistry,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) =>
        new AvroRegistry(config.kafka.schemaRegistryUrl),
    },
    {
      provide: KAFKA_PRODUCER,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => createProducer(config),
    },
    { provide: EventPublisher, useClass: KafkaEventPublisher },
    OutboxRelay,
    OutboxMonitor,
    OutboxCleanupJob,
    UserPurgeJob,
    {
      provide: SCHEDULED_JOBS,
      inject: [OutboxCleanupJob, UserPurgeJob],
      useFactory: (cleanup: OutboxCleanupJob, purge: UserPurgeJob) => [
        cleanup,
        purge,
      ],
    },
    JobScheduler,
  ],
  exports: [OutboxMonitor, OutboxRelay, JobScheduler],
})
export class MessagingModule {}
