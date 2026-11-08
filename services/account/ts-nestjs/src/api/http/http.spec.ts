import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { IsEmail, IsNotEmpty, IsString } from 'class-validator';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  NotFoundException,
  RateLimitedException,
} from '../../domain/exceptions/app.exception.js';
import { PageQueryDto } from '../../dto/page-query.dto.js';
import { ConfigModule } from '../../config/config.module.js';
import { I18nModule } from '../../i18n/i18n.module.js';
import { LOGGER } from '../../infra/logger.js';
import { parseSort, toPage } from '../../util/pagination.js';
import { ProblemFilter } from './filters/problem.filter.js';
import { setupHttp } from './setup-http.js';

class CreateItemDto {
  @IsString()
  @IsNotEmpty()
  title!: string;

  @IsEmail()
  email!: string;
}

@Controller('probe')
class ProbeController {
  @Get('missing')
  missing() {
    throw new NotFoundException('Wallpaper', 'wp_1');
  }
  @Get('slow-down')
  slowDown() {
    throw new RateLimitedException(30);
  }
  @Get('boom')
  boom() {
    throw new Error('secret: db password is hunter2');
  }
  @Get('page')
  page(@Query() q: PageQueryDto) {
    const sort = parseSort(q.sort, ['createdAt', 'title'], {
      field: 'createdAt',
      direction: 'desc',
    });
    return { ...toPage([], 0, q), sort };
  }
  @Post('items')
  create(@Body() dto: CreateItemDto) {
    return dto;
  }
}

describe('HTTP pipeline', () => {
  let app: NestFastifyApplication;
  const logger = pino({ level: 'silent' });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule, I18nModule],
      controllers: [ProbeController],
      providers: [
        { provide: LOGGER, useValue: logger },
        { provide: APP_FILTER, useClass: ProblemFilter },
      ],
    }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter(),
    );
    setupHttp(app, logger);
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(() => app.close());

  const get = (url: string, headers: Record<string, string> = {}) =>
    app.inject({ method: 'GET', url, headers });

  it('maps AppException to problem+json (404) with a trace id', async () => {
    const res = await get('/api/v1/probe/missing', {
      traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
    });
    expect(res.statusCode).toBe(404);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.json()).toMatchObject({
      type: 'https://wallpaperhub.dev/problems/not-found',
      title: 'Resource not found',
      status: 404,
      instance: '/api/v1/probe/missing',
      traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
    });
  });

  it('localizes from Accept-Language', async () => {
    const res = await get('/api/v1/probe/missing', {
      'accept-language': 'de-DE,de;q=0.9',
    });
    expect(res.json().title).toBe('Ressource nicht gefunden');
  });

  it('sends Retry-After on 429', async () => {
    const res = await get('/api/v1/probe/slow-down', {
      'accept-language': 'es',
    });
    expect(res.statusCode).toBe(429);
    expect(res.headers['retry-after']).toBe('30');
    expect(res.json().detail).toContain('30');
  });

  it('hides internals of unexpected errors', async () => {
    const res = await get('/api/v1/probe/boom');
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain('hunter2');
    expect(res.json().type).toBe(
      'https://wallpaperhub.dev/problems/internal-error',
    );
  });

  it('turns unknown routes into problem+json 404', async () => {
    const res = await get('/api/v1/nope');
    expect(res.statusCode).toBe(404);
    expect(res.headers['content-type']).toContain('application/problem+json');
  });

  it('reports field-level validation errors, localized', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/probe/items',
      headers: { 'accept-language': 'de' },
      payload: { title: '', email: 'not-an-email', extra: 1 },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.type).toBe(
      'https://wallpaperhub.dev/problems/validation-failed',
    );
    expect(body.errors).toEqual(
      expect.arrayContaining([
        {
          field: 'title',
          code: 'NotBlank',
          message: 'Title darf nicht leer sein.',
        },
        {
          field: 'email',
          code: 'Email',
          message: 'Email muss eine gültige E-Mail-Adresse sein.',
        },
        {
          field: 'extra',
          code: 'UnknownField',
          message: 'Extra ist kein erlaubtes Feld.',
        },
      ]),
    );
  });

  it('rejects malformed JSON with 400 problem+json', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/probe/items',
      headers: { 'content-type': 'application/json' },
      payload: '{ not json',
    });
    expect(res.statusCode).toBe(400);
    expect(res.headers['content-type']).toContain('application/problem+json');
  });

  it('applies pagination defaults and caps size at 100', async () => {
    const ok = await get('/api/v1/probe/page');
    expect(ok.json()).toMatchObject({
      page: 0,
      size: 20,
      totalItems: 0,
      sort: { field: 'createdAt', direction: 'desc' },
    });

    const tooBig = await get('/api/v1/probe/page?size=101');
    expect(tooBig.statusCode).toBe(400);
    expect(tooBig.json().errors).toEqual([
      expect.objectContaining({ field: 'size', code: 'Max' }),
    ]);

    const badSort = await get('/api/v1/probe/page?sort=password,asc');
    expect(badSort.statusCode).toBe(400);
  });

  it('echoes or generates X-Request-Id and sets security headers', async () => {
    const mine = await get('/api/v1/probe/page', { 'x-request-id': 'abc-123' });
    expect(mine.headers['x-request-id']).toBe('abc-123');
    expect(mine.headers['x-content-type-options']).toBe('nosniff');

    const hostile = await get('/api/v1/probe/page', {
      'x-request-id': 'bad id with spaces\t',
    });
    expect(hostile.headers['x-request-id']).toMatch(/^[\da-f-]{36}$/);
  });
});
