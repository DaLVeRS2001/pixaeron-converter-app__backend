import { Injectable } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';

import { PrismaService } from '../../prisma/prisma.service';

const DAY_MS = 24 * 60 * 60 * 1000;

@Injectable()
export class SessionCleanupService {
  constructor(private readonly prisma: PrismaService) {}

  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async deleteExpiredAuthSessionsAndEvents() {
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
