import { HttpStatus, Injectable, type NestMiddleware } from '@nestjs/common';
import { InjectRedis } from '@nestjs-redis/client';
import type { NextFunction, Request, Response } from 'express';
import type { RedisClientType } from 'redis';

import { SessionMetadataService } from '../session/services/session-metadata.service';

const HTTP_LIMITS = [
  { name: 'second', ttl: 1_000, limit: 30 },
  { name: 'minute', ttl: 60_000, limit: 600 },
  { name: 'quarter-hour', ttl: 15 * 60_000, limit: 6_000 },
];

const INCREMENT_WINDOWS_SCRIPT = `
  local retryAfter = 0

  for index, key in ipairs(KEYS) do
    local count = redis.call('INCR', key)
    local ttl = tonumber(ARGV[(index - 1) * 2 + 1])
    local limit = tonumber(ARGV[(index - 1) * 2 + 2])

    if count == 1 then
      redis.call('PEXPIRE', key, ttl)
    end

    if count > limit then
      local remaining = redis.call('PTTL', key)
      if remaining > retryAfter then
        retryAfter = remaining
      end
    end
  end

  return retryAfter
`;

@Injectable()
export class HttpRateLimitMiddleware implements NestMiddleware {
  constructor(
    @InjectRedis() private readonly redis: RedisClientType,
    private readonly sessionMetadataService: SessionMetadataService,
  ) {}

  async use(request: Request, response: Response, next: NextFunction) {
    if (request.method === 'OPTIONS') {
      next();
      return;
    }

    const ipHash =
      this.sessionMetadataService.getFromRequest(request).ipHash ?? 'unknown';
    let retryAfterMs: number;

    try {
      retryAfterMs = Number(
        await this.redis.eval(INCREMENT_WINDOWS_SCRIPT, {
          keys: HTTP_LIMITS.map(({ name }) => `auth:http:${name}:${ipHash}`),
          arguments: HTTP_LIMITS.flatMap(({ ttl, limit }) => [
            String(ttl),
            String(limit),
          ]),
        }),
      );
    } catch {
      response.status(HttpStatus.SERVICE_UNAVAILABLE).json({
        statusCode: HttpStatus.SERVICE_UNAVAILABLE,
        message: 'Service temporarily unavailable',
      });
      return;
    }

    if (retryAfterMs > 0) {
      response.setHeader('Retry-After', Math.ceil(retryAfterMs / 1_000));
      response.status(HttpStatus.TOO_MANY_REQUESTS).json({
        statusCode: HttpStatus.TOO_MANY_REQUESTS,
        message: 'Too many requests',
      });
      return;
    }

    next();
  }
}
