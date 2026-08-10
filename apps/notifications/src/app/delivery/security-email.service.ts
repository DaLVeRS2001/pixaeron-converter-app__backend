import {
  SecurityEmailPurpose,
  SendSecurityEmailResult,
  type SendSecurityEmailRequest,
  type SendSecurityEmailResponse,
} from '@pixaeron/notifications-contract';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

import {
  EmailCommandResult,
  EmailDeliveryStatus,
  EmailDestinationStatus,
  EmailPurpose,
  type EmailDelivery,
} from '../../generated/prisma/client';
import {
  isUniqueConstraintError,
  type Transaction,
} from '../prisma/prisma.support';
import { PrismaService } from '../prisma/prisma.service';
import {
  renderSecurityEmail,
  type SecurityEmailContent,
} from './email-templates';
import { lockRecipientAliases } from './recipient-advisory-lock';
import {
  matchesRecipientHash,
  normalizeRecipient,
  recipientHashFilter,
  RecipientHashService,
  type RecipientHash,
} from './recipient-hash.service';
import { SesEmailService, type SesSubmissionResult } from './ses-email.service';

// Keep reconciliation behind the SES abort timeout, including final DB writes.
const DELIVERY_LEASE_MARGIN_MS = 1_000;
const RESULT_POLL_MS = 50;

type DeliveryClaim = {
  delivery: EmailDelivery;
  isNew: boolean;
};

export class EmailCommandConflictError extends Error {}

@Injectable()
export class SecurityEmailService {
  private readonly deliveryLeaseMs: number;
  private readonly frontendOrigin: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly recipientHashService: RecipientHashService,
    private readonly sesEmailService: SesEmailService,
    configService: ConfigService,
  ) {
    const sesRequestTimeoutMs = Number(
      configService.getOrThrow<string>('SES_REQUEST_TIMEOUT_MS'),
    );
    this.deliveryLeaseMs = sesRequestTimeoutMs + DELIVERY_LEASE_MARGIN_MS;
    this.frontendOrigin = configService.getOrThrow<string>('FRONTEND_URL');
  }

  async send(
    request: SendSecurityEmailRequest,
    deadlineAt: number,
  ): Promise<SendSecurityEmailResponse> {
    const recipient = normalizeRecipient(request.recipient);
    const recipientHash = this.recipientHashService.create(recipient);
    const lookupHashes =
      this.recipientHashService.createLookupHashes(recipient);
    const claim = await this.claimDelivery(
      request,
      recipientHash,
      lookupHashes,
    );

    if (claim.delivery.callerResult) {
      return toCommandResponse(
        claim.delivery.callerResult,
        claim.delivery.callerResultCode,
      );
    }

    if (!claim.isNew) {
      return this.waitForCallerResult(claim.delivery, deadlineAt);
    }

    return this.submit(claim.delivery, request, recipient);
  }

  private async claimDelivery(
    request: SendSecurityEmailRequest,
    recipientHash: RecipientHash,
    lookupHashes: RecipientHash[],
  ): Promise<DeliveryClaim> {
    try {
      return await this.prisma.$transaction(async (transaction) => {
        const existing = await transaction.emailDelivery.findUnique({
          where: { requestId: request.requestId },
        });

        if (existing) {
          assertSameCommand(existing, request, lookupHashes);
          return { delivery: existing, isNew: false };
        }

        await lockRecipientAliases(transaction, lookupHashes);

        const blockedDestination = await transaction.emailDestination.findFirst(
          {
            where: {
              status: {
                in: [
                  EmailDestinationStatus.SUPPRESSED,
                  EmailDestinationStatus.RECOVERY_PENDING,
                ],
              },
              OR: recipientHashFilter(lookupHashes),
            },
            select: { id: true },
          },
        );
        const now = new Date();
        const delivery = await transaction.emailDelivery.create({
          data: {
            requestId: request.requestId,
            publicSubject: request.publicSubject,
            recipientHash: recipientHash.value,
            recipientHashKeyVersion: recipientHash.keyVersion,
            purpose: toEmailPurpose(request),
            contentVersion: request.contentVersion,
            tokenFingerprint: createTokenFingerprint(request.token),
            ...(blockedDestination
              ? {
                  status: EmailDeliveryStatus.SUPPRESSED,
                  callerResult: EmailCommandResult.SUPPRESSED,
                  callerResultCode: 'DESTINATION_SUPPRESSED',
                  failureCode: 'DESTINATION_SUPPRESSED',
                  finalizedAt: now,
                }
              : {
                  leaseExpiresAt: new Date(
                    now.getTime() + this.deliveryLeaseMs,
                  ),
                }),
          },
        });

        return { delivery, isNew: !blockedDestination };
      });
    } catch (error) {
      if (!isUniqueConstraintError(error)) throw error;

      const existing = await this.prisma.emailDelivery.findUnique({
        where: { requestId: request.requestId },
      });
      if (!existing) throw error;

      assertSameCommand(existing, request, lookupHashes);
      return { delivery: existing, isNew: false };
    }
  }

  private async waitForCallerResult(
    initial: EmailDelivery,
    deadlineAt: number,
  ): Promise<SendSecurityEmailResponse> {
    let delivery = initial;

    while (Date.now() < deadlineAt) {
      if (delivery.callerResult) {
        return toCommandResponse(
          delivery.callerResult,
          delivery.callerResultCode,
        );
      }

      if (delivery.leaseExpiresAt && delivery.leaseExpiresAt <= new Date()) {
        delivery = await this.expireClaim(delivery.id);
        continue;
      }

      const remainingMs = deadlineAt - Date.now();
      if (remainingMs <= 0) break;

      await delay(Math.min(RESULT_POLL_MS, remainingMs));
      delivery = await this.prisma.emailDelivery.findUniqueOrThrow({
        where: { id: delivery.id },
      });
    }

    // This is a transient duplicate response. Persisting it would prevent the
    // command owner from recording the eventual provider result.
    return unknownResponse('COMMAND_IN_PROGRESS');
  }

  private async expireClaim(deliveryId: string): Promise<EmailDelivery> {
    const now = new Date();
    await this.prisma.emailDelivery.updateMany({
      where: {
        id: deliveryId,
        status: EmailDeliveryStatus.PENDING,
        callerResult: null,
        leaseExpiresAt: { lte: now },
      },
      data: {
        status: EmailDeliveryStatus.SUBMISSION_UNKNOWN,
        callerResult: EmailCommandResult.SUBMISSION_UNKNOWN,
        callerResultCode: 'SUBMISSION_LEASE_EXPIRED',
        failureCode: 'SUBMISSION_LEASE_EXPIRED',
        leaseExpiresAt: null,
        finalizedAt: now,
      },
    });

    return this.prisma.emailDelivery.findUniqueOrThrow({
      where: { id: deliveryId },
    });
  }

  private async submit(
    delivery: EmailDelivery,
    request: SendSecurityEmailRequest,
    recipient: string,
  ): Promise<SendSecurityEmailResponse> {
    // The caller deadline only bounds how long a duplicate caller polls
    // (waitForCallerResult) and the gRPC transport. Once a claim is won, the
    // email is worth sending even if the original caller has stopped waiting,
    // so the SES attempt uses the provider's own request timeout rather than
    // the caller's leftover budget. Otherwise a slow claim would strand the
    // delivery in a terminal FAILED state and silently drop the email.
    const attempted = await this.prisma.emailDelivery.updateMany({
      where: {
        id: delivery.id,
        status: EmailDeliveryStatus.PENDING,
        attemptCount: 0,
      },
      data: { attemptCount: 1 },
    });

    if (attempted.count !== 1) {
      const current = await this.prisma.emailDelivery.findUniqueOrThrow({
        where: { id: delivery.id },
      });
      return current.callerResult
        ? toCommandResponse(current.callerResult, current.callerResultCode)
        : unknownResponse('COMMAND_IN_PROGRESS');
    }

    const submission = await this.createSubmission(request, recipient);

    return this.finalizeResult(delivery.id, submission);
  }

  private async finalizeResult(
    deliveryId: string,
    submission: SesSubmissionResult,
  ): Promise<SendSecurityEmailResponse> {
    try {
      const persisted = await this.finalizeSubmission(deliveryId, submission);
      return persisted.callerResult
        ? toCommandResponse(persisted.callerResult, persisted.callerResultCode)
        : unknownResponse('DELIVERY_STATE_UNAVAILABLE');
    } catch {
      return this.readRecordedResult(deliveryId);
    }
  }

  private async createSubmission(
    request: SendSecurityEmailRequest,
    recipient: string,
  ): Promise<SesSubmissionResult> {
    let content: SecurityEmailContent;
    try {
      content = renderSecurityEmail(
        request.purpose,
        request.token,
        this.frontendOrigin,
        request.contentVersion,
      );
    } catch {
      return { status: 'FAILED', code: 'EMAIL_RENDER_FAILED' };
    }

    try {
      return await this.sesEmailService.submit(
        recipient,
        request.requestId,
        content,
      );
    } catch {
      return {
        status: 'SUBMISSION_UNKNOWN',
        code: 'SES_SUBMISSION_UNKNOWN',
      };
    }
  }

  private async finalizeSubmission(
    deliveryId: string,
    submission: SesSubmissionResult,
  ): Promise<EmailDelivery> {
    return this.prisma.$transaction(async (transaction) => {
      const now = new Date();
      await this.persistProviderOutcome(
        transaction,
        deliveryId,
        submission,
        now,
      );
      await transaction.emailDelivery.updateMany({
        where: { id: deliveryId, callerResult: null },
        data: {
          callerResult: toCommandResult(submission.status),
          callerResultCode: 'code' in submission ? submission.code : null,
          leaseExpiresAt: null,
          finalizedAt: now,
        },
      });

      return transaction.emailDelivery.findUniqueOrThrow({
        where: { id: deliveryId },
      });
    });
  }

  private async persistProviderOutcome(
    transaction: Transaction,
    deliveryId: string,
    submission: SesSubmissionResult,
    recordedAt: Date,
  ): Promise<void> {
    if ('messageId' in submission) {
      const attached = await transaction.emailDelivery.updateMany({
        where: {
          id: deliveryId,
          providerMessageId: null,
        },
        data: { providerMessageId: submission.messageId },
      });
      if (attached.count === 0) {
        const current = await transaction.emailDelivery.findUniqueOrThrow({
          where: { id: deliveryId },
          select: { providerMessageId: true },
        });
        if (current.providerMessageId !== submission.messageId) {
          throw new Error('SES submission conflicts with the stored delivery');
        }
      }

      await transaction.emailDelivery.updateMany({
        where: { id: deliveryId, submittedAt: null },
        data: { submittedAt: recordedAt },
      });
    }

    const replaceableStatuses =
      submission.status === 'SUBMISSION_UNKNOWN'
        ? [EmailDeliveryStatus.PENDING]
        : [EmailDeliveryStatus.PENDING, EmailDeliveryStatus.SUBMISSION_UNKNOWN];
    await transaction.emailDelivery.updateMany({
      where: { id: deliveryId, status: { in: replaceableStatuses } },
      data: {
        status: toDeliveryStatus(submission.status),
        failureCode: 'code' in submission ? submission.code : null,
        leaseExpiresAt: null,
      },
    });
  }

  private async readRecordedResult(
    deliveryId: string,
  ): Promise<SendSecurityEmailResponse> {
    try {
      const delivery = await this.prisma.emailDelivery.findUnique({
        where: { id: deliveryId },
      });
      return delivery?.callerResult
        ? toCommandResponse(delivery.callerResult, delivery.callerResultCode)
        : unknownResponse('DELIVERY_STATE_UNAVAILABLE');
    } catch {
      return unknownResponse('DELIVERY_STATE_UNAVAILABLE');
    }
  }
}

function assertSameCommand(
  delivery: EmailDelivery,
  request: SendSecurityEmailRequest,
  recipientHashes: RecipientHash[],
): void {
  const recipientMatches = matchesRecipientHash(delivery, recipientHashes);
  const matches =
    delivery.publicSubject === request.publicSubject &&
    recipientMatches &&
    delivery.purpose === toEmailPurpose(request) &&
    delivery.contentVersion === request.contentVersion &&
    delivery.tokenFingerprint === createTokenFingerprint(request.token);

  if (!matches) throw new EmailCommandConflictError();
}

function toEmailPurpose(request: SendSecurityEmailRequest): EmailPurpose {
  return request.purpose ===
    SecurityEmailPurpose.SECURITY_EMAIL_PURPOSE_EMAIL_VERIFICATION
    ? EmailPurpose.EMAIL_VERIFICATION
    : EmailPurpose.PASSWORD_RESET;
}

function toCommandResult(
  status: SesSubmissionResult['status'],
): EmailCommandResult {
  return EmailCommandResult[status];
}

function toDeliveryStatus(
  status: SesSubmissionResult['status'],
): EmailDeliveryStatus {
  return EmailDeliveryStatus[status];
}

function createTokenFingerprint(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function toCommandResponse(
  result: EmailCommandResult,
  code: string | null,
): SendSecurityEmailResponse {
  return {
    result: SendSecurityEmailResult[`SEND_SECURITY_EMAIL_RESULT_${result}`],
    ...(code ? { code } : {}),
  };
}

function unknownResponse(code: string): SendSecurityEmailResponse {
  return {
    result:
      SendSecurityEmailResult.SEND_SECURITY_EMAIL_RESULT_SUBMISSION_UNKNOWN,
    code,
  };
}
