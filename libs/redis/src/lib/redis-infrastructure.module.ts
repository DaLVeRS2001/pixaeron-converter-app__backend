import { DynamicModule, Global, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { RedisModule } from '@nestjs-redis/client';

import { RedisCacheService } from './redis-cache.service';
import { RedisLockService } from './redis-lock.service';
import { REDIS_NAMESPACE } from './redis-options';

@Global()
@Module({})
export class RedisInfrastructureModule {
  static forRoot(namespace: string): DynamicModule {
    return {
      module: RedisInfrastructureModule,
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
      providers: [
        { provide: REDIS_NAMESPACE, useValue: namespace },
        RedisCacheService,
        RedisLockService,
      ],
      exports: [RedisCacheService, RedisLockService],
    };
  }
}
