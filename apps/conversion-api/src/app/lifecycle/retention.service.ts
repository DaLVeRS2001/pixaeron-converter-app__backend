import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';

import { ConversionFileStatus } from '../../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { OPEN_BATCH_STATUSES, rollUpBatch } from './batch-rollup';

const EXPIRABLE_FILE_STATUSES = [
  ConversionFileStatus.UPLOADING,
  ConversionFileStatus.READY,
  ConversionFileStatus.QUEUED,
  ConversionFileStatus.PROCESSING,
  ConversionFileStatus.COMPLETED,
];
const SWEEP_FILE_LIMIT = 2000;
const SWEEP_BATCH_LIMIT = 200;

@Injectable()
export class RetentionService {
  private readonly logger = new Logger(RetentionService.name);

  constructor(private readonly prisma: PrismaService) {}

  @Cron(CronExpression.EVERY_10_MINUTES, { waitForCompletion: true })
  async expireOverdueFiles(): Promise<void> {
    const now = new Date();
    const overdueFile = {
      status: { in: EXPIRABLE_FILE_STATUSES },
      expiresAt: { lte: now },
    };

    const overdueFiles = await this.prisma.conversionFile.findMany({
      where: overdueFile,
      select: { batchId: true },
      orderBy: { expiresAt: 'asc' },
      take: SWEEP_FILE_LIMIT,
    });
    const abandonedBatches = await this.prisma.conversionBatch.findMany({
      where: {
        status: { in: OPEN_BATCH_STATUSES },
        expiresAt: { lte: now },
      },
      select: { id: true },
      orderBy: { expiresAt: 'asc' },
      take: SWEEP_BATCH_LIMIT,
    });

    const batchIds = new Set([
      ...overdueFiles.map(({ batchId }) => batchId),
      ...abandonedBatches.map(({ id }) => id),
    ]);

    for (const batchId of batchIds) {
      try {
        await this.prisma.$transaction(async (transaction) => {
          await transaction.$queryRaw`
            SELECT 1 FROM "conversion_batches" WHERE "id" = ${batchId} FOR UPDATE
          `;

          await transaction.conversionFile.updateMany({
            where: { batchId, ...overdueFile },
            data: { status: ConversionFileStatus.EXPIRED },
          });

          await rollUpBatch(transaction, batchId);
        });
      } catch (error) {
        this.logger.error(
          `Expiring conversion batch ${batchId} failed: ${(error as Error).message}`,
        );
      }
    }

    if (batchIds.size > 0) {
      this.logger.log(
        `Retention sweep expired files in ${batchIds.size} batches`,
      );
    }
  }
}
