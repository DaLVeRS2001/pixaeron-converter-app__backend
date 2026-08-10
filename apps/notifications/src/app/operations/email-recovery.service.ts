import { Injectable } from '@nestjs/common';
import { isUUID } from 'class-validator';

import {
  EmailDestinationStatus,
  EmailRecoveryAction,
  Prisma,
  type EmailDestination,
  type EmailRecoveryAudit,
} from '../../generated/prisma/client';
import {
  recipientHashFilter,
  RecipientHashService,
} from '../delivery/recipient-hash.service';
import { PrismaService } from '../prisma/prisma.service';

const ACTOR_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const REASON_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,99}$/;
const EVIDENCE_REFERENCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/#-]{0,254}$/;
const PROVIDER_REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{0,254}$/;

export type RecoveryEvidence = {
  operationId: string;
  expectedSuppressionRevision: number;
  actorId: string;
  reasonCode: string;
  evidenceReference: string;
  providerRequestId?: string;
};

export type EmailRecoveryInspection = {
  status: EmailDestinationStatus | 'MIXED';
  maximumSuppressionRevision: number;
  aliasCount: number;
};

export class EmailRecoveryStateError extends Error {}
export class EmailRecoveryOperationConflictError extends Error {}

@Injectable()
export class EmailRecoveryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly recipientHashService: RecipientHashService,
  ) {}

  async inspectRecovery(recipient: string): Promise<EmailRecoveryInspection> {
    const lookupHashes =
      this.recipientHashService.createLookupHashes(recipient);
    const aliases = await this.prisma.emailDestination.findMany({
      where: {
        OR: recipientHashFilter(lookupHashes),
      },
      select: { status: true, suppressionRevision: true },
    });
    const [firstAlias] = aliases;
    if (!firstAlias) {
      throw new EmailRecoveryStateError('Email destination does not exist');
    }

    const hasMixedStatus = aliases.some(
      ({ status }) => status !== firstAlias.status,
    );

    return {
      status: hasMixedStatus ? 'MIXED' : firstAlias.status,
      maximumSuppressionRevision: Math.max(
        ...aliases.map(({ suppressionRevision }) => suppressionRevision),
      ),
      aliasCount: aliases.length,
    };
  }

  requestRecovery(
    recipient: string,
    evidence: RecoveryEvidence,
  ): Promise<void> {
    return this.transition(
      recipient,
      EmailDestinationStatus.SUPPRESSED,
      EmailDestinationStatus.RECOVERY_PENDING,
      EmailRecoveryAction.REQUESTED,
      evidence,
    );
  }

  completeRecovery(
    recipient: string,
    evidence: RecoveryEvidence,
  ): Promise<void> {
    return this.transition(
      recipient,
      EmailDestinationStatus.RECOVERY_PENDING,
      EmailDestinationStatus.ACTIVE,
      EmailRecoveryAction.COMPLETED,
      evidence,
    );
  }

  failRecovery(recipient: string, evidence: RecoveryEvidence): Promise<void> {
    return this.transition(
      recipient,
      EmailDestinationStatus.RECOVERY_PENDING,
      EmailDestinationStatus.SUPPRESSED,
      EmailRecoveryAction.FAILED,
      evidence,
    );
  }

  private async transition(
    recipient: string,
    expectedStatus: EmailDestinationStatus,
    nextStatus: EmailDestinationStatus,
    action: EmailRecoveryAction,
    evidence: RecoveryEvidence,
  ): Promise<void> {
    validateRecoveryEvidence(evidence, action);
    const lookupHashes =
      this.recipientHashService.createLookupHashes(recipient);

    await this.prisma.$transaction(async (transaction) => {
      await transaction.$executeRaw(
        Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${evidence.operationId}, 0))`,
      );

      const destinations = await transaction.emailDestination.findMany({
        where: {
          OR: recipientHashFilter(lookupHashes),
        },
      });
      if (destinations.length === 0) {
        throw new EmailRecoveryStateError('Email destination does not exist');
      }

      const existingAudits = await transaction.emailRecoveryAudit.findMany({
        where: { operationId: evidence.operationId },
      });
      if (existingAudits.length > 0) {
        if (
          isExactReplay(
            existingAudits,
            destinations,
            expectedStatus,
            nextStatus,
            action,
            evidence,
          )
        ) {
          return;
        }
        throw new EmailRecoveryOperationConflictError(
          'Recovery operation ID was already used for a different command',
        );
      }

      assertExpectedState(destinations, expectedStatus, evidence);
      const updated = await transaction.emailDestination.updateMany({
        where: {
          OR: destinations.map(({ id, suppressionRevision }) => ({
            id,
            status: expectedStatus,
            suppressionRevision,
          })),
        },
        data: destinationUpdate(nextStatus),
      });
      if (updated.count !== destinations.length) {
        throw new EmailRecoveryStateError(
          'Email destination changed during recovery',
        );
      }

      await transaction.emailRecoveryAudit.createMany({
        data: destinations.map((destination) => ({
          destinationId: destination.id,
          operationId: evidence.operationId,
          action,
          actorId: evidence.actorId,
          reasonCode: evidence.reasonCode,
          evidenceReference: evidence.evidenceReference,
          providerRequestId: evidence.providerRequestId,
          previousStatus: expectedStatus,
          nextStatus,
          suppressionRevision: destination.suppressionRevision,
        })),
      });
    });
  }
}

export function validateRecoveryEvidence(
  evidence: RecoveryEvidence,
  action: EmailRecoveryAction,
): void {
  if (!isUUID(evidence.operationId, '4')) {
    throw new Error('operation-id must be a UUID v4');
  }
  if (
    !Number.isSafeInteger(evidence.expectedSuppressionRevision) ||
    evidence.expectedSuppressionRevision < 1
  ) {
    throw new Error('suppression-revision must be a positive integer');
  }
  validateIdentifier(evidence.actorId, ACTOR_ID_PATTERN, 'actor');
  validateIdentifier(evidence.reasonCode, REASON_CODE_PATTERN, 'reason');
  validateIdentifier(
    evidence.evidenceReference,
    EVIDENCE_REFERENCE_PATTERN,
    'evidence',
  );

  const providerRequestId = evidence.providerRequestId;
  if (action === EmailRecoveryAction.COMPLETED && !providerRequestId) {
    throw new Error('provider-request is required for completion');
  }
  if (
    providerRequestId &&
    !PROVIDER_REQUEST_ID_PATTERN.test(providerRequestId)
  ) {
    throw new Error('provider-request must be an opaque identifier');
  }
}

function validateIdentifier(
  value: string,
  pattern: RegExp,
  name: string,
): void {
  if (value !== value.trim() || !pattern.test(value)) {
    throw new Error(`${name} must be an opaque identifier`);
  }
}

function assertExpectedState(
  destinations: EmailDestination[],
  expectedStatus: EmailDestinationStatus,
  evidence: RecoveryEvidence,
): void {
  const hasUnexpectedStatus = destinations.some(
    ({ status }) => status !== expectedStatus,
  );
  const currentMailboxRevision = Math.max(
    ...destinations.map(({ suppressionRevision }) => suppressionRevision),
  );
  if (
    hasUnexpectedStatus ||
    currentMailboxRevision !== evidence.expectedSuppressionRevision
  ) {
    throw new EmailRecoveryStateError(
      `Email destination must be ${expectedStatus} at suppression revision ${evidence.expectedSuppressionRevision}`,
    );
  }
}

function isExactReplay(
  audits: EmailRecoveryAudit[],
  destinations: EmailDestination[],
  previousStatus: EmailDestinationStatus,
  nextStatus: EmailDestinationStatus,
  action: EmailRecoveryAction,
  evidence: RecoveryEvidence,
): boolean {
  const recipientDestinationIds = new Set(destinations.map(({ id }) => id));
  const recordedMailboxRevision = Math.max(
    ...audits.map(({ suppressionRevision }) => suppressionRevision),
  );
  if (recordedMailboxRevision !== evidence.expectedSuppressionRevision) {
    return false;
  }

  return audits.every(
    (audit) =>
      recipientDestinationIds.has(audit.destinationId) &&
      audit.action === action &&
      audit.actorId === evidence.actorId &&
      audit.reasonCode === evidence.reasonCode &&
      audit.evidenceReference === evidence.evidenceReference &&
      audit.providerRequestId === (evidence.providerRequestId ?? null) &&
      audit.previousStatus === previousStatus &&
      audit.nextStatus === nextStatus,
  );
}

function destinationUpdate(
  nextStatus: EmailDestinationStatus,
): Prisma.EmailDestinationUpdateManyMutationInput {
  if (nextStatus === EmailDestinationStatus.ACTIVE) {
    return {
      status: nextStatus,
      reasonCode: null,
      suppressedAt: null,
    };
  }

  return { status: nextStatus };
}
