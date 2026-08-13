import { HttpException, HttpStatus } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  EntitlementPlanCode,
  type EntitlementSnapshot,
} from '@pixaeron/entitlements-contract';
import {
  Args,
  Context,
  ID,
  Mutation,
  Query,
  Resolver,
} from '@pixaeron/graphql';
import type { HttpContext } from '@pixaeron/nestjs';

import {
  ConversionFileStatus,
  type ConversionBatch as ConversionBatchRow,
  type ConversionFile as ConversionFileRow,
} from '../../generated/prisma/client';
import {
  AdmissionError,
  AdmissionService,
  PLAN_CODES,
  type AdmissionErrorCode,
  type BatchOwnership,
} from '../admission/admission.service';
import { UploadCompletionService } from '../admission/upload-completion.service';
import { EntitlementsClient } from '../entitlements/entitlements.client';
import { AnonymousIdentityService } from '../identity/anonymous-identity.service';
import { InputObjectStorageService } from '../storage/input-object-storage.service';
import { CONVERSION_MUTATION_RATE_LIMIT } from './constants/rate-limit.constants';
import { CompleteConversionUploadsInput } from './dto/complete-conversion-uploads.input';
import { CreateConversionBatchInput } from './dto/create-conversion-batch.input';
import {
  CompleteConversionUploadsPayload,
  ConversionBatch,
  ConversionEntitlement,
  ConversionFile,
} from './models/conversion.model';

const ADMISSION_STATUS: Record<AdmissionErrorCode, HttpStatus> = {
  BATCH_NOT_FOUND: HttpStatus.NOT_FOUND,
  BATCH_NOT_ADMITTABLE: HttpStatus.CONFLICT,
  BATCH_SIZE_INVALID: HttpStatus.BAD_REQUEST,
  BATCH_TOKEN_MISMATCH: HttpStatus.CONFLICT,
  DAILY_QUOTA_EXCEEDED: HttpStatus.TOO_MANY_REQUESTS,
  FILE_NOT_MEASURED: HttpStatus.CONFLICT,
  FILE_TOO_LARGE: HttpStatus.BAD_REQUEST,
  IDEMPOTENCY_CONFLICT: HttpStatus.CONFLICT,
};

@Resolver()
export class ConversionResolver {
  constructor(
    private readonly admission: AdmissionService,
    private readonly uploadCompletion: UploadCompletionService,
    private readonly entitlements: EntitlementsClient,
    private readonly identity: AnonymousIdentityService,
    private readonly storage: InputObjectStorageService,
  ) {}

  @Mutation(() => ConversionBatch)
  @Throttle(CONVERSION_MUTATION_RATE_LIMIT)
  async createConversionBatch(
    @Args('input') input: CreateConversionBatchInput,
    @Context() context: HttpContext,
  ): Promise<ConversionBatch> {
    const snapshot = await this.anonymousSnapshot();

    try {
      const created = await this.admission.createBatch(
        {
          subject: this.subjectFrom(context),
          anonymous: true,
          idempotencyKey: input.idempotencyKey,
          fileCount: input.fileCount,
          batchToken: input.batchToken,
        },
        snapshot,
      );

      return this.toBatchModel(
        created.batch,
        created.files,
        created.batchToken,
        snapshot,
      );
    } catch (error) {
      rethrowAdmissionError(error);
    }
  }

  @Mutation(() => CompleteConversionUploadsPayload)
  @Throttle(CONVERSION_MUTATION_RATE_LIMIT)
  async completeConversionUploads(
    @Args('input') input: CompleteConversionUploadsInput,
    @Context() context: HttpContext,
  ): Promise<CompleteConversionUploadsPayload> {
    const snapshot = await this.anonymousSnapshot();
    const ownership: BatchOwnership = {
      subject: this.subjectFrom(context),
      batchToken: input.batchToken,
    };

    try {
      const batch = await this.admission.getOwnedBatch(
        input.batchId,
        ownership,
      );
      const completion = await this.uploadCompletion.completeUploads(
        batch,
        ownership,
        snapshot,
      );
      const refreshed = await this.admission.getOwnedBatch(
        input.batchId,
        ownership,
      );

      return {
        batch: await this.toBatchModel(
          refreshed,
          refreshed.files,
          null,
          snapshot,
        ),
        admittedFiles: completion.admittedFiles,
        verifiedFiles: completion.verifiedFiles,
        missingFiles: completion.missingFiles,
      };
    } catch (error) {
      rethrowAdmissionError(error);
    }
  }

  @Query(() => ConversionBatch)
  async conversionBatch(
    @Args('id', { type: () => ID }) id: string,
    @Args('batchToken', { type: () => String, nullable: true })
    batchToken: string | null,
    @Context() context: HttpContext,
  ): Promise<ConversionBatch> {
    try {
      const batch = await this.admission.getOwnedBatch(id, {
        subject: this.subjectFrom(context),
        batchToken,
      });

      return this.toBatchModel(batch, batch.files, null, null);
    } catch (error) {
      rethrowAdmissionError(error);
    }
  }

  @Query(() => ConversionEntitlement)
  async conversionEntitlement(
    @Context() context: HttpContext,
  ): Promise<ConversionEntitlement> {
    const snapshot = await this.anonymousSnapshot();
    const planCode = PLAN_CODES[snapshot.planCode];
    if (!planCode) {
      throw new Error(`Unmapped entitlement plan code ${snapshot.planCode}`);
    }

    return {
      planCode,
      maxBatchFiles: snapshot.maxBatchFiles,
      maxFileBytes: snapshot.maxFileBytes,
      dailyFiles: snapshot.dailyFiles ?? null,
      remainingToday:
        snapshot.dailyFiles === undefined
          ? null
          : await this.admission.remainingToday(
              this.subjectFrom(context),
              snapshot.dailyFiles,
            ),
      maxConcurrentFiles: snapshot.maxConcurrentFiles,
    };
  }

  private async anonymousSnapshot(): Promise<EntitlementSnapshot> {
    const response = await this.entitlements.getEntitlement({
      planCode: EntitlementPlanCode.ENTITLEMENT_PLAN_CODE_ANONYMOUS,
    });
    if (!response.snapshot) {
      throw new Error('Entitlement response carried no snapshot');
    }

    return response.snapshot;
  }

  private subjectFrom(context: HttpContext): string {
    const request = context.req;
    const ip = request.ip || request.socket.remoteAddress || 'unknown';

    return this.identity.subjectFor(ip);
  }

  private async toBatchModel(
    batch: ConversionBatchRow,
    files: ConversionFileRow[],
    batchToken: string | null,
    snapshot: EntitlementSnapshot | null,
  ): Promise<ConversionBatch> {
    return {
      id: batch.id,
      status: batch.status,
      fileCount: batch.fileCount,
      expiresAt: batch.expiresAt,
      batchToken,
      files: await Promise.all(
        files.map(async (file) => this.toFileModel(file, snapshot)),
      ),
    };
  }

  private async toFileModel(
    file: ConversionFileRow,
    snapshot: EntitlementSnapshot | null,
  ): Promise<ConversionFile> {
    const presignable =
      snapshot !== null && file.status === ConversionFileStatus.UPLOADING;

    return {
      id: file.id,
      status: file.status,
      inputBytes: file.inputBytes === null ? null : Number(file.inputBytes),
      resultKind: file.resultKind,
      upload: presignable
        ? await this.uploadTargetFor(file.inputObjectKey, snapshot)
        : null,
    };
  }

  private async uploadTargetFor(
    inputObjectKey: string,
    snapshot: EntitlementSnapshot,
  ) {
    const target = await this.storage.presignUpload(
      inputObjectKey,
      snapshot.maxFileBytes,
    );

    return {
      url: target.url,
      fields: Object.entries(target.fields).map(([name, value]) => ({
        name,
        value,
      })),
    };
  }
}

function rethrowAdmissionError(error: unknown): never {
  if (!(error instanceof AdmissionError)) throw error;

  const statusCode = ADMISSION_STATUS[error.code];
  throw new HttpException(
    { statusCode, code: error.code, message: error.code },
    statusCode,
  );
}
