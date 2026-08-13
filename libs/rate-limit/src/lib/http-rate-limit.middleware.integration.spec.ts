import { HttpStatus } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { createClient } from 'redis';

import { HttpRateLimitMiddleware } from './http-rate-limit.middleware';
import type { RateLimitOptions } from './rate-limit.options';

const SECOND_LIMIT = 5;
const MINUTE_LIMIT = 12;

const createOptions = (): RateLimitOptions => ({
  namespace: `rate-limit-integration-${randomUUID()}`,
  ipHashSecretConfigKey: 'IP_HASH_SECRET',
  httpLimits: [
    { name: 'second', ttl: 1_000, limit: SECOND_LIMIT },
    { name: 'minute', ttl: 60_000, limit: MINUTE_LIMIT },
  ],
  throttlers: [],
});

const configService = {
  getOrThrow: (key: string) => {
    if (key !== 'IP_HASH_SECRET') {
      throw new Error(`Missing configuration value: ${key}`);
    }
    return 'rate-limit-integration-ip-hash-secret';
  },
} as never;

const fire = async (middleware: HttpRateLimitMiddleware, ip: string) => {
  const state = {
    body: undefined as unknown,
    headers: {} as Record<string, number | string>,
    status: undefined as number | undefined,
  };
  const response = {
    setHeader: (name: string, value: number) => {
      state.headers[name] = value;
    },
    status(code: number) {
      state.status = code;
      return this;
    },
    json: (body: unknown) => {
      state.body = body;
    },
  } as unknown as Response;
  let passed = false;

  await middleware.use({ method: 'POST', ip } as Request, response, (() => {
    passed = true;
  }) as NextFunction);

  return { passed, state };
};

describe('HttpRateLimitMiddleware on Redis', () => {
  let redis: ReturnType<typeof createClient>;

  beforeAll(async () => {
    redis = createClient({
      url: process.env['REDIS_URL'],
      disableOfflineQueue: true,
    });
    await redis.connect();
  });

  afterAll(async () => {
    await redis.close();
  });

  it('admits exactly the window budgets under parallel fire', async () => {
    const middleware = new HttpRateLimitMiddleware(
      redis as never,
      configService,
      createOptions(),
    );

    const firstBatch = await Promise.all(
      Array.from({ length: 10 }, () => fire(middleware, '203.0.113.10')),
    );
    expect(firstBatch.filter(({ passed }) => passed)).toHaveLength(
      SECOND_LIMIT,
    );
    for (const { passed, state } of firstBatch) {
      if (passed) continue;
      expect(state.status).toBe(HttpStatus.TOO_MANY_REQUESTS);
      expect(state.headers['Retry-After']).toBe(1);
    }

    await new Promise((resolve) => setTimeout(resolve, 600));
    const midWindow = await fire(middleware, '203.0.113.10');
    expect(midWindow.passed).toBe(false);
    expect(midWindow.state.headers['Retry-After']).toBe(1);

    await new Promise((resolve) => setTimeout(resolve, 600));
    const freshWindow = await fire(middleware, '203.0.113.10');
    expect(freshWindow.passed).toBe(true);

    const secondBatch = await Promise.all(
      Array.from({ length: 10 }, () => fire(middleware, '203.0.113.10')),
    );
    for (const { passed, state } of secondBatch) {
      expect(passed).toBe(false);
      expect(state.status).toBe(HttpStatus.TOO_MANY_REQUESTS);
      expect(state.headers['Retry-After']).toBeGreaterThanOrEqual(55);
    }

    const otherIp = await fire(middleware, '203.0.113.11');
    expect(otherIp.passed).toBe(true);
  });

  it('fails closed with 503 when the client has no usable connection', async () => {
    const middleware = new HttpRateLimitMiddleware(
      createClient({
        url: 'redis://127.0.0.1:1',
        disableOfflineQueue: true,
      }) as never,
      configService,
      createOptions(),
    );

    const { passed, state } = await fire(middleware, '203.0.113.10');

    expect(passed).toBe(false);
    expect(state.status).toBe(HttpStatus.SERVICE_UNAVAILABLE);
    expect(state.body).toEqual({
      statusCode: HttpStatus.SERVICE_UNAVAILABLE,
      message: 'Service temporarily unavailable',
    });
  });
});
