import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  PAID_LARGE_QUEUE,
  queueForTier,
  type ConversionRequestMessage,
  type ConversionRetentionClass,
} from '@pixaeron/conversion-contract';
import {
  EntitlementPlanCode,
  type EntitlementSnapshot,
} from '@pixaeron/entitlements-contract';
import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';

import {
  ConversionBatchStatus,
  ConversionFileStatus,
  ConversionPlanCode,
  Prisma,
  type ConversionBatch,
  type ConversionFile,
} from '../../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { isUniqueConstraintError } from '../prisma/prisma.support';

const UPLOAD_WINDOW_MS = 24 * 60 * 60 * 1000;

const RETENTION_CLASS_BY_HOURS: Record<number, ConversionRetentionClass> = {
  48: 'standard',
  168: 'extended',
};

const PLAN_CODES: Partial<Record<EntitlementPlanCode, ConversionPlanCode>> = {
  [EntitlementPlanCode.ENTITLEMENT_PLAN_CODE_ANONYMOUS]:
    ConversionPlanCode.ANONYMOUS,
  [EntitlementPlanCode.ENTITLEMENT_PLAN_CODE_FREE]: ConversionPlanCode.FREE,
  [EntitlementPlanCode.ENTITLEMENT_PLAN_CODE_LIGHT]: ConversionPlanCode.LIGHT,
  [EntitlementPlanCode.ENTITLEMENT_PLAN_CODE_PRO]: ConversionPlanCode.PRO,
};

export const planCodeFor = (
  snapshot: EntitlementSnapshot,
): ConversionPlanCode => {
  const planCode = PLAN_CODES[snapshot.planCode];
  if (!planCode) {
    throw new Error(`Unmapped entitlement plan code ${snapshot.planCode}`);
  }

  return planCode;
};

const FIRST_PAID_TIER = 2;

export type AdmissionErrorCode =
  | 'BATCH_NOT_FOUND'
  | 'BATCH_NOT_ADMITTABLE'
  | 'BATCH_SIZE_INVALID'
  | 'BATCH_TOKEN_MISMATCH'
  | 'DAILY_QUOTA_EXCEEDED'
  | 'FILE_NOT_MEASURED'
  | 'FILE_TOO_LARGE'
  | 'IDEMPOTENCY_CONFLICT';

export class AdmissionError extends Error {
  constructor(readonly code: AdmissionErrorCode) {
    super(code);
  }
}

export type CreateBatchInput = {
  subject: string;
  anonymous: boolean;
  idempotencyKey: string;
  fileCount: number;
  batchToken?: string | null;
};

export type CreatedBatch = {
  batch: ConversionBatch;
  files: ConversionFile[];
  batchToken: string | null;
  replayed: boolean;
};

export type BatchOwnership = {
  subject: string;
  batchToken?: string | null;
};

export type AdmissionResult = {
  batch: ConversionBatch;
  admittedFiles: number;
};

type ClaimedFile = {
  id: string;
  input_object_key: string;
  input_etag: string | null;
  input_bytes: bigint | null;
};

@Injectable()
export class AdmissionService {
  readonly largeQueueBytes: number;

  constructor(
    private readonly prisma: PrismaService,
    configService: ConfigService,
  ) {
    this.largeQueueBytes = Number(
      configService.getOrThrow<string>('CONVERSION_LARGE_QUEUE_BYTES'),
    );
  }

  async createBatch(
    input: CreateBatchInput,
    snapshot: EntitlementSnapshot,
  ): Promise<CreatedBatch> {
    if (input.fileCount < 1 || input.fileCount > snapshot.maxBatchFiles) {
      throw new AdmissionError('BATCH_SIZE_INVALID');
    }

    const planCode = planCodeFor(snapshot);

    const batchId = randomUUID();
    const batchToken = input.anonymous
      ? randomBytes(32).toString('base64url')
      : null;
    const expiresAt = new Date(Date.now() + UPLOAD_WINDOW_MS);

    try {
      const batch = await this.prisma.conversionBatch.create({
        data: {
          id: batchId,
          subject: input.subject,
          batchTokenHash: batchToken ? digest(batchToken) : null,
          idempotencyKey: input.idempotencyKey,
          planCode,
          planRevision: snapshot.revision,
          fileCount: input.fileCount,
          expiresAt,
          files: {
            create: Array.from({ length: input.fileCount }, () => {
              const fileId = randomUUID();
              return {
                id: fileId,
                inputObjectKey: `inputs/${batchId}/${fileId}`,
                expiresAt,
              };
            }),
          },
        },
        include: { files: true },
      });

      return { batch, files: batch.files, batchToken, replayed: false };
    } catch (error) {
      const conflictsOnBatch =
        isUniqueConstraintError(error) &&
        (error as Prisma.PrismaClientKnownRequestError).meta?.['modelName'] ===
          'ConversionBatch';
      if (!conflictsOnBatch) throw error;

      const existing = await this.prisma.conversionBatch.findUnique({
        where: {
          subject_idempotencyKey: {
            subject: input.subject,
            idempotencyKey: input.idempotencyKey,
          },
        },
        include: { files: true },
      });
      if (!existing) throw error;

      this.assertOwnership(
        existing,
        { subject: input.subject, batchToken: input.batchToken },
        'BATCH_TOKEN_MISMATCH',
      );
      if (existing.fileCount !== input.fileCount) {
        throw new AdmissionError('IDEMPOTENCY_CONFLICT');
      }

      return {
        batch: existing,
        files: existing.files,
        batchToken: null,
        replayed: true,
      };
    }
  }

  async getOwnedBatch(
    batchId: string,
    ownership: BatchOwnership,
  ): Promise<ConversionBatch & { files: ConversionFile[] }> {
    const batch = await this.prisma.conversionBatch.findUnique({
      where: { id: batchId },
      include: { files: { orderBy: { id: 'asc' } } },
    });
    if (!batch) throw new AdmissionError('BATCH_NOT_FOUND');
    this.assertOwnership(batch, ownership, 'BATCH_NOT_FOUND');

    return batch;
  }

  async admitReadyFiles(
    batchId: string,
    ownership: BatchOwnership,
    snapshot: EntitlementSnapshot,
  ): Promise<AdmissionResult> {
    const outputRetention =
      RETENTION_CLASS_BY_HOURS[snapshot.outputRetentionHours];
    if (!outputRetention) {
      throw new Error(
        `Unmapped output retention ${snapshot.outputRetentionHours}h for plan ${snapshot.planCode}`,
      );
    }

    const batch = await this.prisma.conversionBatch.findUnique({
      where: { id: batchId },
    });
    if (!batch) throw new AdmissionError('BATCH_NOT_FOUND');
    this.assertOwnership(batch, ownership, 'BATCH_NOT_FOUND');

    if (
      batch.status !== ConversionBatchStatus.UPLOADING &&
      batch.status !== ConversionBatchStatus.QUEUED
    ) {
      throw new AdmissionError('BATCH_NOT_ADMITTABLE');
    }
    if (batch.expiresAt <= new Date()) {
      throw new AdmissionError('BATCH_NOT_ADMITTABLE');
    }

    return this.prisma.$transaction(async (transaction) => {
      await transaction.$queryRaw`
        SELECT 1 FROM "conversion_batches" WHERE "id" = ${batch.id} FOR UPDATE
      `;

      const claimed = await transaction.$queryRaw<ClaimedFile[]>`
        SELECT "id", "input_object_key", "input_etag", "input_bytes"
        FROM "conversion_files"
        WHERE "batch_id" = ${batch.id} AND "status" = 'READY'
        ORDER BY "id"
        FOR UPDATE
      `;

      if (claimed.length === 0) {
        const current = await transaction.conversionBatch.findUniqueOrThrow({
          where: { id: batch.id },
        });

        return { batch: current, admittedFiles: 0 };
      }

      for (const file of claimed) {
        if (file.input_bytes === null || file.input_etag === null) {
          throw new AdmissionError('FILE_NOT_MEASURED');
        }
        if (Number(file.input_bytes) > snapshot.maxFileBytes) {
          throw new AdmissionError('FILE_TOO_LARGE');
        }
      }

      if (snapshot.dailyFiles !== undefined) {
        if (claimed.length > snapshot.dailyFiles) {
          throw new AdmissionError('DAILY_QUOTA_EXCEEDED');
        }

        const reserved = await transaction.$queryRaw<
          Array<{ subject: string }>
        >`
          INSERT INTO "daily_usage" ("subject", "usage_date", "admitted_files", "updated_at")
          VALUES (${batch.subject}, (now() AT TIME ZONE 'utc')::date, ${claimed.length}, now())
          ON CONFLICT ("subject", "usage_date") DO UPDATE
            SET "admitted_files" = "daily_usage"."admitted_files" + ${claimed.length},
                "updated_at" = now()
            WHERE "daily_usage"."admitted_files" + ${claimed.length} <= ${snapshot.dailyFiles}
          RETURNING "subject"
        `;
        if (reserved.length === 0) {
          throw new AdmissionError('DAILY_QUOTA_EXCEEDED');
        }
      }

      const retentionExpiresAt = new Date(
        Date.now() + snapshot.outputRetentionHours * 60 * 60 * 1000,
      );
      await transaction.conversionFile.updateMany({
        where: { id: { in: claimed.map(({ id }) => id) } },
        data: {
          status: ConversionFileStatus.QUEUED,
          expiresAt: retentionExpiresAt,
        },
      });

      const batchClaim = await transaction.conversionBatch.updateMany({
        where: {
          id: batch.id,
          status: {
            in: [ConversionBatchStatus.UPLOADING, ConversionBatchStatus.QUEUED],
          },
        },
        data: {
          status: ConversionBatchStatus.QUEUED,
          expiresAt: retentionExpiresAt,
        },
      });
      if (batchClaim.count !== 1) {
        throw new AdmissionError('BATCH_NOT_ADMITTABLE');
      }

      const tierQueue = queueForTier(snapshot.queueTier);

      await transaction.outboxEvent.createMany({
        data: claimed.map((file) => ({
          queue:
            snapshot.queueTier >= FIRST_PAID_TIER &&
            Number(file.input_bytes) > this.largeQueueBytes
              ? PAID_LARGE_QUEUE
              : tierQueue,
          payload: {
            fileId: file.id,
            batchId: batch.id,
            inputObjectKey: file.input_object_key,
            inputEtag: file.input_etag as string,
            outputRetention,
          } satisfies ConversionRequestMessage,
        })),
      });

      return {
        batch: {
          ...batch,
          status: ConversionBatchStatus.QUEUED,
          expiresAt: retentionExpiresAt,
        },
        admittedFiles: claimed.length,
      };
    });
  }

  async remainingToday(subject: string, dailyFiles: number): Promise<number> {
    const rows = await this.prisma.$queryRaw<Array<{ admitted_files: number }>>`
      SELECT "admitted_files"
      FROM "daily_usage"
      WHERE "subject" = ${subject}
        AND "usage_date" = (now() AT TIME ZONE 'utc')::date
    `;

    return Math.max(0, dailyFiles - (rows[0]?.admitted_files ?? 0));
  }

  private assertOwnership(
    batch: ConversionBatch,
    ownership: BatchOwnership,
    mismatchCode: AdmissionErrorCode,
  ): void {
    if (batch.subject !== ownership.subject) {
      throw new AdmissionError('BATCH_NOT_FOUND');
    }
    if (!batch.batchTokenHash) return;

    const expected = Buffer.from(batch.batchTokenHash, 'hex');
    const presented = ownership.batchToken
      ? Buffer.from(digest(ownership.batchToken), 'hex')
      : null;

    if (
      !presented ||
      presented.length !== expected.length ||
      !timingSafeEqual(presented, expected)
    ) {
      throw new AdmissionError(mismatchCode);
    }
  }
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
