import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { RedisToken } from '@nestjs-redis/client';
import {
  RedisThrottlerStorage,
  ThrottlerAlgorithm,
} from '@nestjs-redis/throttler-storage';
import { minutes, seconds, ThrottlerModule } from '@nestjs/throttler';
import type { RedisClientType } from 'redis';

import { GqlThrottlerGuard } from './gql-throttler.guard';
import { HttpRateLimitMiddleware } from './http-rate-limit.middleware';

@Module({
  imports: [
    ThrottlerModule.forRootAsync({
      inject: [RedisToken()],
      useFactory: (redis: RedisClientType) => ({
        throttlers: [
          { name: 'short', limit: 20, ttl: seconds(1) },
          { name: 'medium', limit: 300, ttl: minutes(1) },
          { name: 'long', limit: 3000, ttl: minutes(15) },
        ],
        storage: new RedisThrottlerStorage(
          redis,
          ThrottlerAlgorithm.SlidingWindowCounter,
        ),
      }),
    }),
  ],
  providers: [
    HttpRateLimitMiddleware,
    {
      provide: APP_GUARD,
      useClass: GqlThrottlerGuard,
    },
  ],
  exports: [HttpRateLimitMiddleware],
})
export class RateLimitModule {}
