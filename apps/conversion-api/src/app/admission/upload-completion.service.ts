import { Injectable } from '@nestjs/common';
import type { EntitlementSnapshot } from '@pixaeron/entitlements-contract';

import {
  ConversionFileStatus,
  type ConversionBatch,
} from '../../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { InputObjectStorageService } from '../storage/input-object-storage.service';
import {
  AdmissionService,
  type AdmissionResult,
  type BatchOwnership,
} from './admission.service';

export type UploadCompletion = AdmissionResult & {
  verifiedFiles: number;
  missingFiles: number;
};

@Injectable()
export class UploadCompletionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: InputObjectStorageService,
    private readonly admission: AdmissionService,
  ) {}

  async completeUploads(
    batch: ConversionBatch,
    ownership: BatchOwnership,
    snapshot: EntitlementSnapshot,
  ): Promise<UploadCompletion> {
    const uploading = await this.prisma.conversionFile.findMany({
      where: { batchId: batch.id, status: ConversionFileStatus.UPLOADING },
    });

    const verifications = await Promise.all(
      uploading.map(async (file) => {
        const stored = await this.storage.headInput(file.inputObjectKey);
        if (!stored) return 0;

        const verified = await this.prisma.conversionFile.updateMany({
          where: { id: file.id, status: ConversionFileStatus.UPLOADING },
          data: {
            status: ConversionFileStatus.READY,
            inputBytes: stored.bytes,
            inputEtag: stored.etag,
          },
        });

        return verified.count;
      }),
    );
    const verifiedFiles = verifications.reduce((sum, count) => sum + count, 0);

    const result = await this.admission.admitReadyFiles(
      batch.id,
      ownership,
      snapshot,
    );

    return {
      ...result,
      verifiedFiles,
      missingFiles: uploading.length - verifiedFiles,
    };
  }
}
