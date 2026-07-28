import { Injectable } from '@nestjs/common';
import type { Request, Response } from 'express';

import {
  AuthTokenType,
  SessionEventType,
  SessionRevokedReason,
} from '../../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { SessionAuditService } from '../../session/audit/session-audit.service';
import { SessionService } from '../../session/services/session.service';
import { UserService } from '../../user/user.service';
import { AuthTokenService } from '../services/auth-token.service';
import { EmailActionInput } from '../dto/email-action.input';
import { ResetPasswordInput } from './reset-password.input';
import {
  AuthRequestResult,
  PasswordResetResult,
  PasswordResetStatus,
} from '../models/auth-result.model';
import { normalizeEmail } from '../helpers/normalize-email';
import { AuthChallengePolicyService } from '../services/auth-challenge-policy.service';
import { AuthEmailDeliveryService } from '../email/auth-email-delivery.service';

@Injectable()
export class PasswordRecoveryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly userService: UserService,
    private readonly sessionService: SessionService,
    private readonly sessionAuditService: SessionAuditService,
    private readonly authTokenService: AuthTokenService,
    private readonly challengePolicy: AuthChallengePolicyService,
    private readonly emailDelivery: AuthEmailDeliveryService,
  ) {}

  async requestPasswordReset(
    { email, captchaToken }: EmailActionInput,
    request: Request,
  ): Promise<AuthRequestResult> {
    this.emailDelivery.assertAvailable();
    const normalizedEmail = normalizeEmail(email);
    await this.challengePolicy.prepareEmailAction(
      'forgot_password',
      normalizedEmail,
      captchaToken,
      request,
    );

    const user = await this.userService.getUser({ email: normalizedEmail });

    if (user?.password) {
      const token = await this.prisma.$transaction(async (transaction) => {
        const issued = await this.authTokenService.issueInTransaction(
          transaction,
          user.id,
          AuthTokenType.PASSWORD_RESET,
        );
        await this.sessionAuditService.recordSecurityEvent(
          SessionEventType.PASSWORD_RESET_REQUESTED,
          request,
          user.id,
          undefined,
          transaction,
        );
        return issued;
      });

      await this.emailDelivery.sendPasswordResetAfterCommit(
        user.id,
        user.email,
        token,
        request,
      );
    } else {
      await this.sessionAuditService.recordSecurityEvent(
        SessionEventType.PASSWORD_RESET_REQUESTED,
        request,
        user?.id,
      );
    }

    return { accepted: true };
  }

  async resetPassword(
    { token, password }: ResetPasswordInput,
    request: Request,
    response: Response,
  ): Promise<PasswordResetResult> {
    const authToken = await this.authTokenService.find(
      token,
      AuthTokenType.PASSWORD_RESET,
    );

    if (!authToken) {
      await this.sessionAuditService.recordSecurityEvent(
        SessionEventType.PASSWORD_RESET_INVALID,
        request,
      );
      return { status: PasswordResetStatus.INVALID };
    }

    if (authToken.consumedAt) {
      await this.sessionAuditService.recordSecurityEvent(
        SessionEventType.PASSWORD_RESET_REUSED,
        request,
        authToken.userId,
      );
      return { status: PasswordResetStatus.ALREADY_USED };
    }

    if (authToken.expiresAt <= new Date()) {
      await this.sessionAuditService.recordSecurityEvent(
        SessionEventType.PASSWORD_RESET_EXPIRED,
        request,
        authToken.userId,
      );
      return { status: PasswordResetStatus.EXPIRED };
    }

    const passwordHash = await this.userService.hashPassword(password);
    const result = await this.prisma.$transaction(async (transaction) => {
      const now = new Date();
      const current = await this.authTokenService.findInTransaction(
        transaction,
        token,
        AuthTokenType.PASSWORD_RESET,
      );

      if (!current) {
        await this.sessionAuditService.recordSecurityEvent(
          SessionEventType.PASSWORD_RESET_INVALID,
          request,
          undefined,
          undefined,
          transaction,
        );
        return PasswordResetStatus.INVALID;
      }

      if (current.consumedAt) {
        await this.sessionAuditService.recordSecurityEvent(
          SessionEventType.PASSWORD_RESET_REUSED,
          request,
          current.userId,
          undefined,
          transaction,
        );
        return PasswordResetStatus.ALREADY_USED;
      }

      if (current.expiresAt <= now) {
        await this.sessionAuditService.recordSecurityEvent(
          SessionEventType.PASSWORD_RESET_EXPIRED,
          request,
          current.userId,
          undefined,
          transaction,
        );
        return PasswordResetStatus.EXPIRED;
      }

      const consumed = await transaction.authToken.updateMany({
        where: {
          id: current.id,
          consumedAt: null,
          expiresAt: { gt: now },
        },
        data: { consumedAt: now },
      });

      if (consumed.count !== 1) {
        await this.sessionAuditService.recordSecurityEvent(
          SessionEventType.PASSWORD_RESET_REUSED,
          request,
          current.userId,
          undefined,
          transaction,
        );
        return PasswordResetStatus.ALREADY_USED;
      }

      await transaction.user.update({
        where: { id: current.userId },
        data: { password: passwordHash },
      });
      const revokedSessions = await transaction.session.updateMany({
        where: { userId: current.userId, revokedAt: null },
        data: {
          revokedAt: now,
          revokedReason: SessionRevokedReason.PASSWORD_CHANGED,
        },
      });
      await this.sessionAuditService.recordPasswordChanged(
        current.userId,
        request,
        revokedSessions.count,
        transaction,
      );
      await this.sessionAuditService.recordSecurityEvent(
        SessionEventType.PASSWORD_RESET_COMPLETED,
        request,
        current.userId,
        undefined,
        transaction,
      );

      return PasswordResetStatus.RESET;
    });

    if (result === PasswordResetStatus.RESET) {
      await this.sessionService.completePasswordChange(response);
    }

    return { status: result };
  }
}
