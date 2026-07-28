import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRedis, type RedisClientType } from '@pixaeron/redis';
import { createHmac } from 'node:crypto';
import type { Request } from 'express';

import { SessionMetadataService } from '../../session/services/session-metadata.service';

export type EmailAction = 'forgot_password' | 'resend_confirmation';

const CAPTCHA_ATTEMPTS = 2;
const MAX_ATTEMPTS = 5;
const WINDOW_MS = 15 * 60 * 1000;
const BLOCK_MS = 15 * 60 * 1000;
const COOLDOWN_MS = 60 * 1000;

const RESERVE_ATTEMPT_SCRIPT = `
  local blockTtl = redis.call('PTTL', KEYS[2])
  if blockTtl > 0 then
    return {0, blockTtl}
  end

  local cooldownTtl = redis.call('PTTL', KEYS[3])
  if cooldownTtl > 0 then
    return {1, cooldownTtl}
  end

  local attempts = redis.call('INCR', KEYS[1])
  if attempts == 1 then
    redis.call('PEXPIRE', KEYS[1], ARGV[1])
  end

  redis.call('SET', KEYS[3], '1', 'PX', ARGV[4])

  if attempts >= tonumber(ARGV[2]) then
    redis.call('SET', KEYS[2], '1', 'PX', ARGV[3])
  end

  return {2, attempts}
`;

@Injectable()
export class EmailActionAttemptService {
  constructor(
    @InjectRedis() private readonly redis: RedisClientType,
    private readonly configService: ConfigService,
    private readonly sessionMetadataService: SessionMetadataService,
  ) {}

  async assertAllowed(
    action: EmailAction,
    email: string,
    request: Request,
  ): Promise<void> {
    const { blockKey, cooldownKey } = this.getKeys(action, email, request);
    const [blockTtl, cooldownTtl] = await Promise.all([
      this.redis.pTTL(blockKey),
      this.redis.pTTL(cooldownKey),
    ]);

    if (blockTtl > 0) {
      this.throwRateLimit('TOO_MANY_AUTH_ATTEMPTS', action, blockTtl);
    }

    if (cooldownTtl > 0) {
      this.throwRateLimit('AUTH_ACTION_COOLDOWN', action, cooldownTtl);
    }
  }

  async isCaptchaRequired(
    action: EmailAction,
    email: string,
    request: Request,
  ): Promise<boolean> {
    const { attemptsKey } = this.getKeys(action, email, request);
    const attempts = Number((await this.redis.get(attemptsKey)) ?? 0);

    return attempts >= CAPTCHA_ATTEMPTS;
  }

  async reserve(
    action: EmailAction,
    email: string,
    request: Request,
  ): Promise<void> {
    const { attemptsKey, blockKey, cooldownKey } = this.getKeys(
      action,
      email,
      request,
    );
    const result = (await this.redis.eval(RESERVE_ATTEMPT_SCRIPT, {
      keys: [attemptsKey, blockKey, cooldownKey],
      arguments: [
        String(WINDOW_MS),
        String(MAX_ATTEMPTS),
        String(BLOCK_MS),
        String(COOLDOWN_MS),
      ],
    })) as [number, number];

    if (result[0] === 0) {
      this.throwRateLimit('TOO_MANY_AUTH_ATTEMPTS', action, result[1]);
    }

    if (result[0] === 1) {
      this.throwRateLimit('AUTH_ACTION_COOLDOWN', action, result[1]);
    }
  }

  async startCooldown(
    action: EmailAction,
    email: string,
    request: Request,
  ): Promise<void> {
    const { cooldownKey } = this.getKeys(action, email, request);
    await this.redis.set(cooldownKey, '1', {
      PX: COOLDOWN_MS,
      NX: true,
    });
  }

  private throwRateLimit(
    code: 'TOO_MANY_AUTH_ATTEMPTS' | 'AUTH_ACTION_COOLDOWN',
    action: EmailAction,
    retryAfterMs: number,
  ): never {
    throw new HttpException(
      {
        statusCode: HttpStatus.TOO_MANY_REQUESTS,
        code,
        action,
        message:
          code === 'AUTH_ACTION_COOLDOWN'
            ? 'Wait before requesting another email.'
            : 'Too many requests. Try again later.',
        retryAfter: Math.ceil(retryAfterMs / 1000),
      },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }

  private getKeys(action: EmailAction, email: string, request: Request) {
    const secret = this.configService.getOrThrow<string>('IP_HASH_SECRET');
    const emailHash = createHmac('sha256', secret).update(email).digest('hex');
    const ipHash =
      this.sessionMetadataService.getFromRequest(request).ipHash ?? 'unknown';
    const attemptPrefix = `auth:${action}:${ipHash}:${emailHash}`;

    return {
      attemptsKey: `${attemptPrefix}:attempts`,
      blockKey: `${attemptPrefix}:block`,
      cooldownKey: `auth:${action}:email:${emailHash}:cooldown`,
    };
  }
}
