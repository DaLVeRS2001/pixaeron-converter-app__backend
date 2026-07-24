import {
  HttpStatus,
  Inject,
  Injectable,
  type NestMiddleware,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRedis, type RedisClientType } from '@pixaeron/redis';
import type { NextFunction, Request, Response } from 'express';
import { createHmac } from 'node:crypto';

import { RATE_LIMIT_OPTIONS } from './rate-limit.options';
import type { RateLimitOptions } from './rate-limit.options';

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
  private readonly ipHashSecret: string;

  constructor(
    @InjectRedis() private readonly redis: RedisClientType,
    configService: ConfigService,
    @Inject(RATE_LIMIT_OPTIONS) private readonly options: RateLimitOptions,
  ) {
    this.ipHashSecret = configService.getOrThrow<string>(
      options.ipHashSecretConfigKey,
    );
  }

  async use(request: Request, response: Response, next: NextFunction) {
    if (request.method === 'OPTIONS') {
      next();
      return;
    }

    const ipHash = createHmac('sha256', this.ipHashSecret)
      .update(request.ip || request.socket.remoteAddress || 'unknown')
      .digest('hex');
    let retryAfterMs: number;

    try {
      retryAfterMs = Number(
        await this.redis.eval(INCREMENT_WINDOWS_SCRIPT, {
          keys: this.options.httpLimits.map(
            ({ name }) => `${this.options.namespace}:http:${name}:${ipHash}`,
          ),
          arguments: this.options.httpLimits.flatMap(({ ttl, limit }) => [
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
