import { Injectable } from '@nestjs/common';
import { InjectRedis } from '@nestjs-redis/client';
import type { RedisClientType } from 'redis';

@Injectable()
export class RedisCacheService {
  constructor(@InjectRedis() private readonly redis: RedisClientType) {}

  async get<T>(key: string): Promise<T | null> {
    const value = (await this.redis.get(`cache:${key}`)) as string | null;

    return value === null ? null : (JSON.parse(value) as T);
  }

  async set(key: string, value: unknown, ttlSeconds: number): Promise<void> {
    await this.redis.set(`cache:${key}`, JSON.stringify(value), {
      EX: ttlSeconds,
    });
  }

  async delete(key: string): Promise<void> {
    await this.redis.del(`cache:${key}`);
  }
}
