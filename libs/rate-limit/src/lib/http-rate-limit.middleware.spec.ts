import { HttpStatus } from '@nestjs/common';
import { createHmac } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

import { HttpRateLimitMiddleware } from './http-rate-limit.middleware';
import type { RateLimitOptions } from './rate-limit.options';

describe('HttpRateLimitMiddleware', () => {
  const redis = { eval: jest.fn() };
  const configService = {
    getOrThrow: jest.fn().mockReturnValue('ip-secret'),
  };
  const options: RateLimitOptions = {
    namespace: 'auth',
    ipHashSecretConfigKey: 'IP_HASH_SECRET',
    httpLimits: [
      { name: 'second', ttl: 1_000, limit: 30 },
      { name: 'minute', ttl: 60_000, limit: 600 },
      { name: 'quarter-hour', ttl: 900_000, limit: 6_000 },
    ],
    throttlers: [],
  };
  const response = {
    setHeader: jest.fn(),
    status: jest.fn().mockReturnThis(),
    json: jest.fn(),
  } as unknown as Response;
  const next = jest.fn() as NextFunction;
  const middleware = new HttpRateLimitMiddleware(
    redis as never,
    configService as never,
    options,
  );

  beforeEach(() => jest.clearAllMocks());

  it('counts the raw HTTP request in namespaced Redis windows', async () => {
    redis.eval.mockResolvedValue(0);
    const ipHash = createHmac('sha256', 'ip-secret')
      .update('203.0.113.10')
      .digest('hex');

    await middleware.use(
      { method: 'POST', ip: '203.0.113.10' } as Request,
      response,
      next,
    );

    expect(redis.eval).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        keys: [
          `auth:http:second:${ipHash}`,
          `auth:http:minute:${ipHash}`,
          `auth:http:quarter-hour:${ipHash}`,
        ],
        arguments: ['1000', '30', '60000', '600', '900000', '6000'],
      }),
    );
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('returns 429 before GraphQL handles an over-limit request', async () => {
    redis.eval.mockResolvedValue(12_500);

    await middleware.use(
      { method: 'POST', ip: '203.0.113.10' } as Request,
      response,
      next,
    );

    expect(response.setHeader).toHaveBeenCalledWith('Retry-After', 13);
    expect(response.status).toHaveBeenCalledWith(HttpStatus.TOO_MANY_REQUESTS);
    expect(next).not.toHaveBeenCalled();
  });

  it('does not count CORS preflight requests', async () => {
    await middleware.use({ method: 'OPTIONS' } as Request, response, next);

    expect(redis.eval).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('fails closed when Redis is unavailable', async () => {
    redis.eval.mockRejectedValue(new Error('Redis unavailable'));

    await middleware.use(
      { method: 'POST', ip: '203.0.113.10' } as Request,
      response,
      next,
    );

    expect(response.status).toHaveBeenCalledWith(
      HttpStatus.SERVICE_UNAVAILABLE,
    );
    expect(response.json).toHaveBeenCalledWith({
      statusCode: HttpStatus.SERVICE_UNAVAILABLE,
      message: 'Service temporarily unavailable',
    });
    expect(next).not.toHaveBeenCalled();
  });
});
