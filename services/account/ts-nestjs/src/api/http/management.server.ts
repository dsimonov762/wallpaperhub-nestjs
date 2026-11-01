import { BeforeApplicationShutdown, Inject, Injectable } from '@nestjs/common';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Logger } from 'pino';
import { APP_CONFIG } from '../../config/config.module.js';
import type { AppConfig } from '../../config/config.js';
import { ProfileCache } from '../../repository/profile-cache.js';
import { OutboxMonitor } from '../../jobs/outbox-monitor.js';
import { LOGGER } from '../../infra/logger.js';
import { HealthService } from './health.service.js';

/**
 * The management port (8081): /health/live, /health/ready, /health/startup.
 * It is a separate tiny HTTP server so it is never exposed through the gateway
 * and keeps answering even if the public API is saturated.
 */
@Injectable()
export class ManagementServer implements BeforeApplicationShutdown {
  private server?: FastifyInstance;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly health: HealthService,
    private readonly outbox: OutboxMonitor,
    private readonly cache: ProfileCache,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  build(): FastifyInstance {
    const server = Fastify({ logger: false });
    server.get('/health/live', async () => ({ status: 'UP' }));
    server.get('/health/startup', async (_req, reply) =>
      this.health.isStarted()
        ? { status: 'UP' }
        : reply.status(503).send({ status: 'DOWN' }),
    );
    server.get('/health/ready', async (_req, reply) => {
      const report = await this.health.readiness();
      return reply.status(report.status === 'UP' ? 200 : 503).send(report);
    });
    // Backlog and relay numbers (never exposed through the gateway: this is the management port).
    server.get('/management/outbox', async () => this.outbox.snapshot());
    server.get('/management/cache', async () => this.cache.stats());
    return server;
  }

  /** Returns the actual port (useful when configured with port 0 in tests). */
  async start(): Promise<number> {
    this.server = this.build();
    await this.server.listen({
      host: this.config.http.host,
      port: this.config.http.mgmtPort,
    });
    const address = this.server.server.address();
    const port =
      typeof address === 'object' && address
        ? address.port
        : this.config.http.mgmtPort;
    this.logger.info({ port }, 'management server listening');
    return port;
  }

  async beforeApplicationShutdown(): Promise<void> {
    this.health.markDraining();
    await this.server?.close();
  }
}
