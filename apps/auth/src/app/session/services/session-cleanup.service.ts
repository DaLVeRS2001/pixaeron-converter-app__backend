import { Injectable } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { RedisLockService } from '@pixaeron/redis';

import { PrismaService } from '../../prisma/prisma.service';

const DAY_MS = 24 * 60 * 60 * 1000;

@Injectable()
export class SessionCleanupService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redisLockService: RedisLockService,
  ) {}

  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async deleteExpiredAuthSessionsAndEvents() {
    const lockToken = await this.redisLockService.acquire(
      'session-cleanup',
      60 * 60 * 1000,
    );

    if (!lockToken) return;

    try {
      await this.deleteExpiredData();
    } finally {
      await this.redisLockService.release('session-cleanup', lockToken);
    }
  }

  private async deleteExpiredData() {
    const now = Date.now();
    const sessionCutoff = new Date(now - 30 * DAY_MS);
    const eventCutoff = new Date(now - 90 * DAY_MS);

    await this.prisma.session.deleteMany({
      where: {
        OR: [
          { expiresAt: { lt: sessionCutoff } },
          { revokedAt: { lt: sessionCutoff } },
        ],
      },
    });

    await this.prisma.sessionEvent.deleteMany({
      where: {
        createdAt: { lt: eventCutoff },
      },
    });
  }
}
