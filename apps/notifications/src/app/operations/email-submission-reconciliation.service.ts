import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';

import {
  EmailCommandResult,
  EmailDeliveryStatus,
} from '../../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class EmailSubmissionReconciliationService {
  private readonly logger = new Logger(
    EmailSubmissionReconciliationService.name,
  );

  constructor(private readonly prisma: PrismaService) {}

  @Cron(CronExpression.EVERY_MINUTE, { waitForCompletion: true })
  async expireStaleClaims(): Promise<void> {
    const expiredAt = new Date();
    const expired = await this.prisma.emailDelivery.updateMany({
      where: {
        status: EmailDeliveryStatus.PENDING,
        callerResult: null,
        leaseExpiresAt: { lte: expiredAt },
      },
      data: {
        status: EmailDeliveryStatus.SUBMISSION_UNKNOWN,
        callerResult: EmailCommandResult.SUBMISSION_UNKNOWN,
        callerResultCode: 'SUBMISSION_LEASE_EXPIRED',
        failureCode: 'SUBMISSION_LEASE_EXPIRED',
        leaseExpiresAt: null,
        finalizedAt: expiredAt,
      },
    });

    if (expired.count > 0) {
      this.logger.warn(
        `Email submission reconciliation finalized ${expired.count} expired claims`,
      );
    }
  }
}
