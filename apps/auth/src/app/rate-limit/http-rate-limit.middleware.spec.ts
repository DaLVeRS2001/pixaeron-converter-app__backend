import { HttpStatus } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';

import type { SessionMetadataService } from '../session/services/session-metadata.service';
import { HttpRateLimitMiddleware } from './http-rate-limit.middleware';

describe('HttpRateLimitMiddleware', () => {
  const redis = { eval: jest.fn() };
  const sessionMetadataService = {
    getFromRequest: jest.fn().mockReturnValue({ ipHash: 'request-ip-hash' }),
  };
  const response = {
    setHeader: jest.fn(),
    status: jest.fn().mockReturnThis(),
    json: jest.fn(),
  } as unknown as Response;
  const next = jest.fn() as NextFunction;
  const middleware = new HttpRateLimitMiddleware(
    redis as never,
    sessionMetadataService as unknown as SessionMetadataService,
  );

  beforeEach(() => jest.clearAllMocks());

  it('counts the raw HTTP request in all Redis windows', async () => {
    redis.eval.mockResolvedValue(0);

    await middleware.use({ method: 'POST' } as Request, response, next);

    expect(redis.eval).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        keys: [
          'auth:http:second:request-ip-hash',
          'auth:http:minute:request-ip-hash',
          'auth:http:quarter-hour:request-ip-hash',
        ],
        arguments: ['1000', '30', '60000', '600', '900000', '6000'],
      }),
    );
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('returns 429 before GraphQL handles an over-limit request', async () => {
    redis.eval.mockResolvedValue(12_500);

    await middleware.use({ method: 'POST' } as Request, response, next);

    expect(response.setHeader).toHaveBeenCalledWith('Retry-After', 13);
    expect(response.status).toHaveBeenCalledWith(HttpStatus.TOO_MANY_REQUESTS);
    expect(response.json).toHaveBeenCalledWith({
      statusCode: HttpStatus.TOO_MANY_REQUESTS,
      message: 'Too many requests',
    });
    expect(next).not.toHaveBeenCalled();
  });

  it('does not count CORS preflight requests', async () => {
    await middleware.use({ method: 'OPTIONS' } as Request, response, next);

    expect(redis.eval).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('fails closed when Redis is unavailable', async () => {
    redis.eval.mockRejectedValue(new Error('Redis unavailable'));

    await middleware.use({ method: 'POST' } as Request, response, next);

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
