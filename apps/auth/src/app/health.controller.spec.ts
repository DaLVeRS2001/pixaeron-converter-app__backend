import type { RedisClientType } from '@pixaeron/redis';

import { HealthController } from './health.controller';
import { PrismaService } from './prisma/prisma.service';

describe('HealthController', () => {
  const prisma = {
    $queryRaw: jest.fn(),
  };
  const redis = {
    ping: jest.fn(),
  };

  const controller = new HealthController(
    prisma as unknown as PrismaService,
    redis as unknown as RedisClientType,
  );

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.$queryRaw.mockResolvedValue([{ '?column?': 1 }]);
    redis.ping.mockResolvedValue('PONG');
  });

  it('reports healthy when PostgreSQL and Redis are available', async () => {
    await expect(controller.check()).resolves.toEqual({ status: 'ok' });
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    expect(redis.ping).toHaveBeenCalledTimes(1);
  });

  it('fails when Redis is unavailable', async () => {
    redis.ping.mockRejectedValue(new Error('Redis unavailable'));

    await expect(controller.check()).rejects.toThrow('Redis unavailable');
  });
});
