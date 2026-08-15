import { Injectable, Logger } from '@nestjs/common';
import {
  outputObjectKey,
  type WorkerResultEvent,
  type WorkerStartedEvent,
} from '@pixaeron/conversion-contract';

import {
  ConversionBatchStatus,
  ConversionFileStatus,
  type Prisma,
} from '../../generated/prisma/client';
import { rollUpBatch } from '../lifecycle/batch-rollup';
import { PrismaService } from '../prisma/prisma.service';
import { InputObjectStorageService } from '../storage/input-object-storage.service';

const EVENT_ACCEPTING_FILE_STATUSES = [
  ConversionFileStatus.QUEUED,
  ConversionFileStatus.PROCESSING,
];

@Injectable()
export class WorkerEventProcessorService {
  private readonly logger = new Logger(WorkerEventProcessorService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: InputObjectStorageService,
  ) {}

  async apply(event: WorkerStartedEvent | WorkerResultEvent): Promise<void> {
    if (event.type === 'STARTED') {
      const started = await this.prisma.conversionFile.updateMany({
        where: {
          id: event.fileId,
          batchId: event.batchId,
          status: { in: EVENT_ACCEPTING_FILE_STATUSES },
          attempt: { lt: event.attempt },
        },
        data: {
          status: ConversionFileStatus.PROCESSING,
          attempt: event.attempt,
          startedAt: new Date(),
        },
      });
      if (started.count === 0) return;

      await this.prisma.conversionBatch.updateMany({
        where: { id: event.batchId, status: ConversionBatchStatus.QUEUED },
        data: { status: ConversionBatchStatus.PROCESSING },
      });
      return;
    }

    const data =
      event.outcome === 'COMPLETED'
        ? await this.verifiedCompletion(event)
        : {
            status: ConversionFileStatus.FAILED,
            failureCode: event.failureCode,
            completedAt: new Date(),
          };

    await this.prisma.$transaction(async (transaction) => {
      await transaction.$queryRaw`
        SELECT 1 FROM "conversion_batches" WHERE "id" = ${event.batchId} FOR UPDATE
      `;

      const claimed = await transaction.conversionFile.updateMany({
        where: {
          id: event.fileId,
          batchId: event.batchId,
          status: { in: EVENT_ACCEPTING_FILE_STATUSES },
          attempt: { lte: event.attempt },
        },
        data,
      });
      if (claimed.count === 0) {
        this.logger.warn(
          `Dropped ${event.outcome} for file ${event.fileId}: attempt ${event.attempt} no longer accepts results`,
        );
        return;
      }

      const status = await rollUpBatch(transaction, event.batchId);
      if (status !== null) {
        this.logger.log(
          `Conversion batch ${event.batchId} finished as ${status}`,
        );
      }
    });
  }

  private async verifiedCompletion(
    event: Extract<WorkerResultEvent, { outcome: 'COMPLETED' }>,
  ): Promise<Prisma.ConversionFileUpdateManyMutationInput> {
    if (
      event.outputObjectKey !==
      outputObjectKey(event.batchId, event.fileId, event.attempt)
    ) {
      throw new Error(
        `Output key ${event.outputObjectKey} does not belong to file ${event.fileId}`,
      );
    }

    const stored = await this.storage.head(event.outputObjectKey);
    if (!stored) {
      throw new Error(`Output object ${event.outputObjectKey} is missing`);
    }
    if (stored.checksumSha256 === null) {
      throw new Error(
        `Output object ${event.outputObjectKey} carries no stored checksum`,
      );
    }
    if (stored.bytes !== event.outputBytes) {
      throw new Error(
        `Output object ${event.outputObjectKey} size ${stored.bytes} contradicts the event`,
      );
    }
    if (stored.checksumSha256 !== event.outputChecksumSha256) {
      throw new Error(
        `Output object ${event.outputObjectKey} checksum contradicts the event`,
      );
    }

    return {
      status: ConversionFileStatus.COMPLETED,
      resultKind: event.resultKind,
      outputObjectKey: event.outputObjectKey,
      outputBytes: event.outputBytes,
      outputChecksum: event.outputChecksumSha256,
      inputFormat: event.inputFormat,
      outputFormat: event.outputFormat,
      frameCount: event.frameCount,
      width: event.width,
      height: event.height,
      completedAt: new Date(),
    };
  }
}
