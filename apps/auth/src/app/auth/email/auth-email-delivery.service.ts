import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  SecurityEmailPurpose,
  SendSecurityEmailResult,
} from '@pixaeron/notifications-contract';
import { randomUUID } from 'node:crypto';
import type { Request } from 'express';

import { Prisma, SessionEventType } from '../../../generated/prisma/client';
import { SessionAuditService } from '../../session/audit/session-audit.service';
import { EmailActionAttemptService } from './email-action-attempt.service';
import { NotificationsEmailClient } from './notifications-email.client';

interface SecurityEmailDelivery {
  userId: number;
  publicSubject: string;
  recipient: string;
  token: string;
  request: Request;
}

type SecurityEmailOutcome =
  | 'ACCEPTED'
  | 'FAILED'
  | 'REJECTED'
  | 'SUPPRESSED'
  | 'SUBMISSION_UNKNOWN';

const SECURITY_EMAIL_CONTENT_VERSION = 1;
const DEFAULT_EMAIL_ACTION_RESPONSE_BUDGET_MS = 2_500;

@Injectable()
export class AuthEmailDeliveryService {
  private readonly logger = new Logger(AuthEmailDeliveryService.name);
  private readonly enabled: boolean;
  private readonly responseBudgetMs: number;

  constructor(
    private readonly notificationsEmailClient: NotificationsEmailClient,
    private readonly emailActionAttemptService: EmailActionAttemptService,
    private readonly sessionAuditService: SessionAuditService,
    configService: ConfigService,
  ) {
    this.enabled =
      configService.get<string>('EMAIL_DELIVERY_ENABLED') === 'true';
    const configuredResponseBudgetMs = configService.get<string>(
      'EMAIL_ACTION_RESPONSE_BUDGET_MS',
    );
    this.responseBudgetMs = Number(
      configuredResponseBudgetMs ?? DEFAULT_EMAIL_ACTION_RESPONSE_BUDGET_MS,
    );
  }

  assertAvailable(): void {
    if (this.enabled) return;

    throw new ServiceUnavailableException({
      code: 'EMAIL_DELIVERY_UNAVAILABLE',
      message: 'Email delivery is temporarily unavailable',
    });
  }

  async runGenericEmailAction(action: () => Promise<void>): Promise<void> {
    const startedAt = Date.now();

    try {
      await action();
    } finally {
      await this.waitForResponseBudget(startedAt);
    }
  }

  async sendEmailVerificationAfterCommit(
    delivery: SecurityEmailDelivery,
    startCooldown: boolean,
  ): Promise<void> {
    if (startCooldown) {
      try {
        await this.emailActionAttemptService.startCooldown(
          'resend_confirmation',
          delivery.recipient,
          delivery.request,
        );
      } catch {
        this.logger.error(
          'Failed to start the post-registration email verification cooldown',
        );
      }
    }

    await this.sendAfterCommit(
      delivery,
      SecurityEmailPurpose.SECURITY_EMAIL_PURPOSE_EMAIL_VERIFICATION,
    );
  }

  sendPasswordResetAfterCommit(delivery: SecurityEmailDelivery): Promise<void> {
    return this.sendAfterCommit(
      delivery,
      SecurityEmailPurpose.SECURITY_EMAIL_PURPOSE_PASSWORD_RESET,
    );
  }

  private async sendAfterCommit(
    delivery: SecurityEmailDelivery,
    purpose: SecurityEmailPurpose,
  ): Promise<void> {
    const requestId = randomUUID();
    let outcome: SecurityEmailOutcome;

    try {
      const response = await this.notificationsEmailClient.sendSecurityEmail({
        requestId,
        publicSubject: delivery.publicSubject,
        recipient: delivery.recipient,
        purpose,
        token: delivery.token,
        contentVersion: SECURITY_EMAIL_CONTENT_VERSION,
      });
      outcome = toSecurityEmailOutcome(response.result);
    } catch {
      outcome = 'SUBMISSION_UNKNOWN';
    }

    const eventType = this.getAuditEventType(purpose, outcome);
    await this.recordEmailOutcomeSafely(
      eventType,
      delivery.request,
      delivery.userId,
      { requestId, outcome },
    );
  }

  private getAuditEventType(
    purpose: SecurityEmailPurpose,
    outcome: SecurityEmailOutcome,
  ): SessionEventType {
    const wasAccepted = outcome === 'ACCEPTED';
    const isEmailVerification =
      purpose ===
      SecurityEmailPurpose.SECURITY_EMAIL_PURPOSE_EMAIL_VERIFICATION;

    if (isEmailVerification) {
      return wasAccepted
        ? SessionEventType.EMAIL_VERIFICATION_ACCEPTED
        : SessionEventType.EMAIL_VERIFICATION_FAILED;
    }

    return wasAccepted
      ? SessionEventType.PASSWORD_RESET_ACCEPTED
      : SessionEventType.PASSWORD_RESET_FAILED;
  }

  private async waitForResponseBudget(startedAt: number): Promise<void> {
    const elapsedMs = Date.now() - startedAt;
    const remainingMs = this.responseBudgetMs - elapsedMs;

    if (remainingMs <= 0) return;

    await new Promise<void>((resolve) => {
      setTimeout(resolve, remainingMs);
    });
  }

  private async recordEmailOutcomeSafely(
    type: SessionEventType,
    request: Request,
    userId: number,
    metadata: Prisma.InputJsonObject,
  ): Promise<void> {
    try {
      await this.sessionAuditService.recordSecurityEvent(
        type,
        request,
        userId,
        metadata,
      );
    } catch {
      this.logger.error('Failed to record a security email outcome audit');
    }
  }
}

function toSecurityEmailOutcome(
  result: SendSecurityEmailResult,
): SecurityEmailOutcome {
  switch (result) {
    case SendSecurityEmailResult.SEND_SECURITY_EMAIL_RESULT_ACCEPTED:
      return 'ACCEPTED';
    case SendSecurityEmailResult.SEND_SECURITY_EMAIL_RESULT_FAILED:
      return 'FAILED';
    case SendSecurityEmailResult.SEND_SECURITY_EMAIL_RESULT_REJECTED:
      return 'REJECTED';
    case SendSecurityEmailResult.SEND_SECURITY_EMAIL_RESULT_SUPPRESSED:
      return 'SUPPRESSED';
    case SendSecurityEmailResult.SEND_SECURITY_EMAIL_RESULT_SUBMISSION_UNKNOWN:
      return 'SUBMISSION_UNKNOWN';
    default:
      return 'SUBMISSION_UNKNOWN';
  }
}
