import { DynamicModule, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import {
  RedisThrottlerStorage,
  ThrottlerAlgorithm,
} from '@nestjs-redis/throttler-storage';
import { ThrottlerModule } from '@nestjs/throttler';
import { RedisToken, type RedisClientType } from '@pixaeron/redis';

import { GqlThrottlerGuard } from './gql-throttler.guard';
import { HttpRateLimitMiddleware } from './http-rate-limit.middleware';
import { RATE_LIMIT_OPTIONS } from './rate-limit.options';
import type { RateLimitOptions } from './rate-limit.options';

@Module({})
export class RateLimitModule {
  static forRoot(options: RateLimitOptions): DynamicModule {
    return {
      module: RateLimitModule,
      imports: [
        ConfigModule,
        ThrottlerModule.forRootAsync({
          inject: [RedisToken()],
          useFactory: (redis: RedisClientType) => ({
            throttlers: options.throttlers,
            getTracker: (request) =>
              `${options.namespace}:${request.ip ?? 'unknown'}`,
            storage: new RedisThrottlerStorage(
              redis,
              ThrottlerAlgorithm.SlidingWindowCounter,
            ),
          }),
        }),
      ],
      providers: [
        { provide: RATE_LIMIT_OPTIONS, useValue: options },
        HttpRateLimitMiddleware,
        {
          provide: APP_GUARD,
          useClass: GqlThrottlerGuard,
        },
      ],
      exports: [HttpRateLimitMiddleware],
    };
  }
}
