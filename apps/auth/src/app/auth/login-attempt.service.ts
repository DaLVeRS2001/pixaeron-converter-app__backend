import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRedis } from '@nestjs-redis/client';
import { createHmac } from 'node:crypto';
import type { Request } from 'express';
import type { RedisClientType } from 'redis';

import { SessionMetadataService } from '../session/services/session-metadata.service';

const MAX_PAIR_FAILURES = 5;
const MAX_IP_FAILURES = 25;
const ATTEMPT_WINDOW_MS = 15 * 60 * 1000;
const BLOCK_DURATION_MS = 15 * 60 * 1000;

const RECORD_FAILURE_SCRIPT = `
  local pairAttempts = redis.call('INCR', KEYS[1])
  if pairAttempts == 1 then
    redis.call('PEXPIRE', KEYS[1], ARGV[1])
  end
  if pairAttempts >= tonumber(ARGV[2]) then
    redis.call('SET', KEYS[3], '1', 'PX', ARGV[4])
  end

  local ipAttempts = redis.call('INCR', KEYS[2])
  if ipAttempts == 1 then
    redis.call('PEXPIRE', KEYS[2], ARGV[1])
  end
  if ipAttempts >= tonumber(ARGV[3]) then
    redis.call('SET', KEYS[4], '1', 'PX', ARGV[4])
  end

  return { pairAttempts, ipAttempts }
`;

@Injectable()
export class LoginAttemptService {
  constructor(
    @InjectRedis() private readonly redis: RedisClientType,
    private readonly configService: ConfigService,
    private readonly sessionMetadataService: SessionMetadataService,
  ) {}

  async assertAllowed(email: string, request: Request): Promise<void> {
    const { pairBlockKey, ipBlockKey } = this.getKeys(email, request);
    const retryAfter = await Promise.all([
      this.redis.pTTL(pairBlockKey),
      this.redis.pTTL(ipBlockKey),
    ]);

    if (retryAfter.some((ttl) => ttl > 0)) {
      throw new HttpException(
        'Too many failed login attempts. Try again later.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  async recordFailure(email: string, request: Request): Promise<void> {
    const { pairAttemptsKey, pairBlockKey, ipAttemptsKey, ipBlockKey } =
      this.getKeys(email, request);

    await this.redis.eval(RECORD_FAILURE_SCRIPT, {
      keys: [pairAttemptsKey, ipAttemptsKey, pairBlockKey, ipBlockKey],
      arguments: [
        String(ATTEMPT_WINDOW_MS),
        String(MAX_PAIR_FAILURES),
        String(MAX_IP_FAILURES),
        String(BLOCK_DURATION_MS),
      ],
    });
  }

  async clear(email: string, request: Request): Promise<void> {
    const { pairAttemptsKey, pairBlockKey } = this.getKeys(email, request);
    await this.redis.del([pairAttemptsKey, pairBlockKey]);
  }

  private getKeys(email: string, request: Request) {
    const secret = this.configService.getOrThrow<string>('IP_HASH_SECRET');
    const emailHash = createHmac('sha256', secret).update(email).digest('hex');
    const ipHash =
      this.sessionMetadataService.getFromRequest(request).ipHash ?? 'unknown';

    return {
      pairAttemptsKey: `auth:login:pair:attempts:${ipHash}:${emailHash}`,
      pairBlockKey: `auth:login:pair:block:${ipHash}:${emailHash}`,
      ipAttemptsKey: `auth:login:ip:attempts:${ipHash}`,
      ipBlockKey: `auth:login:ip:block:${ipHash}`,
    };
  }
}
