import { Injectable } from '@nestjs/common';
import { InjectRedis } from '@nestjs-redis/client';
import { randomUUID } from 'node:crypto';
import type { RedisClientType } from 'redis';

const RELEASE_LOCK_SCRIPT = `
  if redis.call('GET', KEYS[1]) == ARGV[1] then
    return redis.call('DEL', KEYS[1])
  end
  return 0
`;

@Injectable()
export class RedisLockService {
  constructor(@InjectRedis() private readonly redis: RedisClientType) {}

  async acquire(key: string, ttlMs: number): Promise<string | null> {
    const token = randomUUID();
    const result = await this.redis.set(`lock:${key}`, token, {
      NX: true,
      PX: ttlMs,
    });

    return result === 'OK' ? token : null;
  }

  async release(key: string, token: string): Promise<void> {
    await this.redis.eval(RELEASE_LOCK_SCRIPT, {
      keys: [`lock:${key}`],
      arguments: [token],
    });
  }
}
