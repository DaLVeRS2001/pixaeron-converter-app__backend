import { Injectable, Logger } from '@nestjs/common';
import type { Request } from 'express';

import { Prisma, SessionEventType } from '../../../generated/prisma/client';
import { SessionAuditService } from '../../session/audit/session-audit.service';
import { EmailActionAttemptService } from './email-action-attempt.service';
import { TransactionalEmailService } from './transactional-email.service';

@Injectable()
export class AuthEmailDeliveryService {
  private readonly logger = new Logger(AuthEmailDeliveryService.name);

  constructor(
    private readonly transactionalEmailService: TransactionalEmailService,
    private readonly emailActionAttemptService: EmailActionAttemptService,
    private readonly sessionAuditService: SessionAuditService,
  ) {}

  assertAvailable(): void {
    this.transactionalEmailService.assertAvailable();
  }

  async sendEmailVerificationAfterCommit(
    userId: number,
    email: string,
    token: string,
    request: Request,
    startCooldown: boolean,
  ): Promise<void> {
    if (startCooldown) {
      try {
        await this.emailActionAttemptService.startCooldown(
          'resend_confirmation',
          email,
          request,
        );
      } catch {
        this.logger.error(
          'Failed to start the post-registration email verification cooldown',
        );
      }
    }

    let receipt;

    try {
      receipt = await this.transactionalEmailService.sendEmailVerification(
        email,
        token,
      );
    } catch {
      await this.recordEmailOutcomeSafely(
        SessionEventType.EMAIL_VERIFICATION_FAILED,
        request,
        userId,
        { reason: 'delivery_failed' },
      );
      return;
    }

    await this.recordEmailOutcomeSafely(
      SessionEventType.EMAIL_VERIFICATION_ACCEPTED,
      request,
      userId,
      {
        provider: receipt.provider,
        providerMessageId: receipt.messageId,
      },
    );
  }

  async sendPasswordResetAfterCommit(
    userId: number,
    email: string,
    token: string,
    request: Request,
  ): Promise<void> {
    let receipt;

    try {
      receipt = await this.transactionalEmailService.sendPasswordReset(
        email,
        token,
      );
    } catch {
      await this.recordEmailOutcomeSafely(
        SessionEventType.PASSWORD_RESET_FAILED,
        request,
        userId,
        { reason: 'delivery_failed' },
      );
      return;
    }

    await this.recordEmailOutcomeSafely(
      SessionEventType.PASSWORD_RESET_ACCEPTED,
      request,
      userId,
      {
        provider: receipt.provider,
        providerMessageId: receipt.messageId,
      },
    );
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
      this.logger.error('Failed to record a transactional email outcome audit');
    }
  }
}
