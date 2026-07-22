import { Inject, Injectable } from '@nestjs/common';
import { InjectRedis } from '@nestjs-redis/client';
import type { RedisClientType } from 'redis';

import { REDIS_NAMESPACE } from './redis-options';

@Injectable()
export class RedisCacheService {
  constructor(
    @InjectRedis() private readonly redis: RedisClientType,
    @Inject(REDIS_NAMESPACE) private readonly namespace: string,
  ) {}

  async get<T>(key: string): Promise<T | null> {
    const value = (await this.redis.get(`${this.namespace}:cache:${key}`)) as
      | string
      | null;

    return value === null ? null : (JSON.parse(value) as T);
  }

  async set(key: string, value: unknown, ttlSeconds: number): Promise<void> {
    await this.redis.set(
      `${this.namespace}:cache:${key}`,
      JSON.stringify(value),
      { EX: ttlSeconds },
    );
  }

  async delete(key: string): Promise<void> {
    await this.redis.del(`${this.namespace}:cache:${key}`);
  }
}
