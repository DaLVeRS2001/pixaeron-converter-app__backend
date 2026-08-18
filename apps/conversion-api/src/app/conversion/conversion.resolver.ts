import { status as grpcStatus } from '@grpc/grpc-js';
import {
  HttpException,
  HttpStatus,
  ServiceUnavailableException,
} from '@nestjs/common';
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
  planCodeFor,
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

const AUTHENTICATED_SUBJECT_HEADER = 'x-authenticated-sub';

const USER_PUBLIC_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type RequestIdentity = {
  subject: string;
  userPublicId: string | null;
};

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
    const identity = this.identityFrom(context);
    const snapshot = await this.snapshotCappedToServedSizes(identity);

    try {
      const created = await this.admission.createBatch(
        {
          subject: identity.subject,
          anonymous: identity.userPublicId === null,
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
    const identity = this.identityFrom(context);
    const snapshot = await this.snapshotCappedToServedSizes(identity);
    const ownership: BatchOwnership = {
      subject: identity.subject,
      batchToken: input.batchToken,
    };

    try {
      const completion = await this.uploadCompletion.completeUploads(
        input.batchId,
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
        subject: this.identityFrom(context).subject,
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
    const identity = this.identityFrom(context);
    const snapshot = await this.snapshotCappedToServedSizes(identity);

    return {
      planCode: planCodeFor(snapshot),
      maxBatchFiles: snapshot.maxBatchFiles,
      maxFileBytes: snapshot.maxFileBytes,
      dailyFiles: snapshot.dailyFiles ?? null,
      remainingToday:
        snapshot.dailyFiles === undefined
          ? null
          : await this.admission.remainingToday(
              identity.subject,
              snapshot.dailyFiles,
            ),
      maxConcurrentFiles: snapshot.maxConcurrentFiles,
    };
  }

  private async snapshotCappedToServedSizes(
    identity: RequestIdentity,
  ): Promise<EntitlementSnapshot> {
    let response;
    try {
      response = await this.entitlements.getEntitlement(
        identity.userPublicId
          ? { subject: identity.userPublicId }
          : { planCode: EntitlementPlanCode.ENTITLEMENT_PLAN_CODE_ANONYMOUS },
      );
    } catch (error) {
      if (
        identity.userPublicId &&
        (error as { code?: number }).code === grpcStatus.NOT_FOUND
      ) {
        throw new HttpException(
          {
            statusCode: HttpStatus.UNAUTHORIZED,
            code: 'SESSION_STALE',
            message: 'The signed-in account no longer exists',
          },
          HttpStatus.UNAUTHORIZED,
        );
      }

      throw new ServiceUnavailableException({
        code: 'ENTITLEMENTS_UNAVAILABLE',
        message: 'Plan limits are temporarily unavailable',
      });
    }
    if (!response.snapshot) {
      throw new Error('Entitlement response carried no snapshot');
    }

    return {
      ...response.snapshot,
      maxFileBytes: Math.min(
        response.snapshot.maxFileBytes,
        this.admission.largeQueueBytes,
      ),
    };
  }

  private identityFrom(context: HttpContext): RequestIdentity {
    const request = context.req;
    const header = request.headers[AUTHENTICATED_SUBJECT_HEADER];
    const candidate = Array.isArray(header) ? header[0] : header;
    if (candidate !== undefined) {
      if (!USER_PUBLIC_ID_PATTERN.test(candidate)) {
        throw new HttpException(
          {
            statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
            code: 'IDENTITY_HEADER_INVALID',
            message: 'The verified subject header is not a public identifier',
          },
          HttpStatus.INTERNAL_SERVER_ERROR,
        );
      }

      return { subject: `user:${candidate}`, userPublicId: candidate };
    }

    const ip = request.ip || request.socket.remoteAddress || 'unknown';

    return { subject: this.identity.subjectFor(ip), userPublicId: null };
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
        files.map(async (file): Promise<ConversionFile> => {
          const presignable =
            snapshot !== null && file.status === ConversionFileStatus.UPLOADING;
          const target = presignable
            ? await this.storage.presignUpload(
                file.inputObjectKey,
                snapshot.maxFileBytes,
              )
            : null;

          const outputObjectKey =
            file.status === ConversionFileStatus.COMPLETED
              ? file.outputObjectKey
              : null;

          return {
            id: file.id,
            status: file.status,
            inputBytes:
              file.inputBytes === null ? null : Number(file.inputBytes),
            resultKind: file.resultKind,
            outputBytes:
              file.outputBytes === null ? null : Number(file.outputBytes),
            outputFormat: file.outputFormat,
            width: file.width,
            height: file.height,
            failureCode: file.failureCode,
            downloadUrl:
              outputObjectKey &&
              (await this.storage.presignDownload(outputObjectKey)),
            upload: target && {
              url: target.url,
              fields: Object.entries(target.fields).map(([name, value]) => ({
                name,
                value,
              })),
            },
          };
        }),
      ),
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
