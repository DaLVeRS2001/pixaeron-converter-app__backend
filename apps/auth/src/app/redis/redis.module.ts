import { Global, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { RedisModule } from '@nestjs-redis/client';

import { RedisCacheService } from './redis-cache.service';
import { RedisLockService } from './redis-lock.service';

@Global()
@Module({
  imports: [
    RedisModule.forRootAsync({
      isGlobal: true,
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        options: {
          url: configService.getOrThrow<string>('REDIS_URL'),
          disableOfflineQueue: true,
          socket: {
            connectTimeout: 5_000,
          },
        },
      }),
    }),
  ],
  providers: [RedisCacheService, RedisLockService],
  exports: [RedisCacheService, RedisLockService],
})
export class AppRedisModule {}
