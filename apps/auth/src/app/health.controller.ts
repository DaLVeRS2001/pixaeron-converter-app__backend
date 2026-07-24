import { Controller, Get } from '@nestjs/common';
import { InjectRedis, type RedisClientType } from '@pixaeron/redis';

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
