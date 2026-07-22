import { Controller, Get } from '@nestjs/common';
import { InjectRedis } from '@nestjs-redis/client';
import type { RedisClientType } from 'redis';

import { PrismaService } from './prisma/prisma.service';

@Controller('health')
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    @InjectRedis() private readonly redis: RedisClientType,
  ) {}

  @Get()
  async check() {
    await Promise.all([this.prisma.$queryRaw`SELECT 1`, this.redis.ping()]);

    return { status: 'ok' };
  }
}
