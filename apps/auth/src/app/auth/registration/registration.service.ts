import { ConflictException, Injectable } from '@nestjs/common';
import type { Request } from 'express';

import {
  AuthTokenType,
  Prisma,
  SessionEventType,
} from '../../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { SessionAuditService } from '../../session/audit/session-audit.service';
import { UserService } from '../../user/user.service';
import { AuthTokenService } from '../services/auth-token.service';
import { AuthTokenInput } from '../dto/auth-token.input';
import { EmailActionInput } from '../dto/email-action.input';
import { RegisterInput } from './register.input';
import { CURRENT_LEGAL_CONSENT_VERSION } from '../constants/legal-consent.constants';
import { assertCurrentLegalConsent } from '../helpers/assert-current-legal-consent';
import {
  AuthRequestResult,
  EmailVerificationResult,
  EmailVerificationStatus,
  RegistrationResult,
} from '../models/auth-result.model';
import { normalizeEmail } from '../helpers/normalize-email';
import { AuthChallengePolicyService } from '../services/auth-challenge-policy.service';
import { AuthEmailDeliveryService } from '../email/auth-email-delivery.service';

@Injectable()
export class RegistrationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly userService: UserService,
    private readonly sessionAuditService: SessionAuditService,
    private readonly authTokenService: AuthTokenService,
    private readonly challengePolicy: AuthChallengePolicyService,
    private readonly emailDelivery: AuthEmailDeliveryService,
  ) {}

  async register(
    {
      email,
      password,
      username,
      captchaToken,
      legalConsentAccepted,
      legalConsentVersion,
    }: RegisterInput,
    request: Request,
  ): Promise<RegistrationResult> {
    assertCurrentLegalConsent(legalConsentAccepted, legalConsentVersion);
    this.emailDelivery.assertAvailable();
    await this.challengePolicy.requireCaptcha(
      captchaToken,
      request,
      'register',
    );

    const normalizedEmail = normalizeEmail(email);
    const existingUser = await this.userService.getUser({
      email: normalizedEmail,
    });

    if (existingUser) {
      throw new ConflictException({
        code: 'EMAIL_ALREADY_REGISTERED',
        message: 'An account with this email already exists',
      });
    }

    const passwordHash = await this.userService.hashPassword(password);
    const registration = await this.prisma
      .$transaction(async (transaction) => {
        const user = await this.userService.createLocalUserInTransaction(
          transaction,
          {
            email: normalizedEmail,
            username: username.trim(),
            passwordHash,
            legalConsentVersion: CURRENT_LEGAL_CONSENT_VERSION,
            legalConsentAcceptedAt: new Date(),
          },
        );
        const verificationToken =
          await this.authTokenService.issueInTransaction(
            transaction,
            user.id,
            AuthTokenType.EMAIL_VERIFICATION,
          );

        await this.sessionAuditService.recordSecurityEvent(
          SessionEventType.REGISTER_SUCCESS,
          request,
          user.id,
          undefined,
          transaction,
        );
        await this.sessionAuditService.recordSecurityEvent(
          SessionEventType.EMAIL_VERIFICATION_REQUESTED,
          request,
          user.id,
          undefined,
          transaction,
        );

        return { user, verificationToken };
      })
      .catch((error: unknown) => {
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === 'P2002'
        ) {
          throw new ConflictException({
            code: 'EMAIL_ALREADY_REGISTERED',
            message: 'An account with this email already exists',
          });
        }

        throw error;
      });

    await this.emailDelivery.sendEmailVerificationAfterCommit(
      registration.user.id,
      registration.user.email,
      registration.verificationToken,
      request,
      true,
    );

    return { accepted: true, email: registration.user.email };
  }

  async resendEmailVerification(
    { email, captchaToken }: EmailActionInput,
    request: Request,
  ): Promise<AuthRequestResult> {
    this.emailDelivery.assertAvailable();
    const normalizedEmail = normalizeEmail(email);
    await this.challengePolicy.prepareEmailAction(
      'resend_confirmation',
      normalizedEmail,
      captchaToken,
      request,
    );

    const user = await this.userService.getUser({ email: normalizedEmail });

    if (user?.emailVerified) {
      await this.sessionAuditService.recordSecurityEvent(
        SessionEventType.EMAIL_ALREADY_VERIFIED,
        request,
        user.id,
      );
    } else if (user) {
      const verificationToken = await this.prisma.$transaction(
        async (transaction) => {
          const issued = await this.authTokenService.issueInTransaction(
            transaction,
            user.id,
            AuthTokenType.EMAIL_VERIFICATION,
          );
          await this.sessionAuditService.recordSecurityEvent(
            SessionEventType.EMAIL_VERIFICATION_REQUESTED,
            request,
            user.id,
            undefined,
            transaction,
          );
          return issued;
        },
      );

      await this.emailDelivery.sendEmailVerificationAfterCommit(
        user.id,
        user.email,
        verificationToken,
        request,
        false,
      );
    } else {
      await this.sessionAuditService.recordSecurityEvent(
        SessionEventType.EMAIL_VERIFICATION_REQUESTED,
        request,
      );
    }

    return { accepted: true };
  }

  async verifyEmail(
    { token }: AuthTokenInput,
    request: Request,
  ): Promise<EmailVerificationResult> {
    return this.prisma.$transaction(async (transaction) => {
      const now = new Date();
      const authToken = await this.authTokenService.findInTransaction(
        transaction,
        token,
        AuthTokenType.EMAIL_VERIFICATION,
      );

      if (!authToken) {
        await this.sessionAuditService.recordSecurityEvent(
          SessionEventType.EMAIL_VERIFICATION_INVALID,
          request,
          undefined,
          undefined,
          transaction,
        );
        return { status: EmailVerificationStatus.INVALID };
      }

      if (authToken.user.emailVerified) {
        await transaction.authToken.updateMany({
          where: { id: authToken.id, consumedAt: null },
          data: { consumedAt: now },
        });
        await this.sessionAuditService.recordSecurityEvent(
          SessionEventType.EMAIL_ALREADY_VERIFIED,
          request,
          authToken.userId,
          undefined,
          transaction,
        );
        return { status: EmailVerificationStatus.ALREADY_VERIFIED };
      }

      if (authToken.consumedAt) {
        await this.sessionAuditService.recordSecurityEvent(
          SessionEventType.EMAIL_VERIFICATION_INVALID,
          request,
          authToken.userId,
          undefined,
          transaction,
        );
        return { status: EmailVerificationStatus.INVALID };
      }

      if (authToken.expiresAt <= now) {
        await this.sessionAuditService.recordSecurityEvent(
          SessionEventType.EMAIL_VERIFICATION_EXPIRED,
          request,
          authToken.userId,
          undefined,
          transaction,
        );
        return { status: EmailVerificationStatus.EXPIRED };
      }

      const consumed = await transaction.authToken.updateMany({
        where: {
          id: authToken.id,
          consumedAt: null,
          expiresAt: { gt: now },
        },
        data: { consumedAt: now },
      });

      if (consumed.count !== 1) {
        const current = await this.authTokenService.findInTransaction(
          transaction,
          token,
          AuthTokenType.EMAIL_VERIFICATION,
        );
        const alreadyVerified = current?.user.emailVerified === true;

        await this.sessionAuditService.recordSecurityEvent(
          alreadyVerified
            ? SessionEventType.EMAIL_ALREADY_VERIFIED
            : SessionEventType.EMAIL_VERIFICATION_INVALID,
          request,
          authToken.userId,
          undefined,
          transaction,
        );
        return {
          status: alreadyVerified
            ? EmailVerificationStatus.ALREADY_VERIFIED
            : EmailVerificationStatus.INVALID,
        };
      }

      await transaction.user.update({
        where: { id: authToken.userId },
        data: { emailVerified: true },
      });
      await this.sessionAuditService.recordSecurityEvent(
        SessionEventType.EMAIL_VERIFIED,
        request,
        authToken.userId,
        undefined,
        transaction,
      );

      return { status: EmailVerificationStatus.VERIFIED };
    });
  }
}
