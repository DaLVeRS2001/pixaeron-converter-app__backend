import {
  ConflictException,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import type { Request, Response } from 'express';

import { Prisma, SessionEventType } from '../../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { SessionService } from '../../session/services/session.service';
import { GoogleLoginInput } from './google-login.input';
import { GoogleTokenService } from './google-token.service';
import { CURRENT_LEGAL_CONSENT_VERSION } from '../constants/legal-consent.constants';
import { assertCurrentLegalConsent } from '../helpers/assert-current-legal-consent';
import { AuthChallengePolicyService } from '../services/auth-challenge-policy.service';

@Injectable()
export class GoogleSignInService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sessionService: SessionService,
    private readonly googleTokenService: GoogleTokenService,
    private readonly challengePolicy: AuthChallengePolicyService,
  ) {}

  async login(
    {
      idToken,
      rememberMe = false,
      captchaToken,
      legalConsentAccepted,
      legalConsentVersion,
    }: GoogleLoginInput,
    request: Request,
    response: Response,
  ) {
    await this.challengePolicy.requireCaptcha(
      captchaToken,
      request,
      'google_login',
    );

    const googleUser = await this.googleTokenService.verifyIdToken(idToken);

    if (!googleUser.emailVerified) {
      throw new ForbiddenException({
        code: 'GOOGLE_EMAIL_NOT_VERIFIED',
        message: 'Google must verify the email before it can be used',
      });
    }

    let user: { id: number };

    try {
      user = await this.prisma.$transaction(async (transaction) => {
        const account = await transaction.account.findUnique({
          where: {
            provider_providerAccountId: {
              provider: 'google',
              providerAccountId: googleUser.providerAccountId,
            },
          },
          include: { user: true },
        });

        if (account) return account.user;

        const existingUser = await transaction.user.findUnique({
          where: { email: googleUser.email },
        });

        if (existingUser) throw this.accountLinkRequired();

        assertCurrentLegalConsent(legalConsentAccepted, legalConsentVersion);

        return transaction.user.create({
          data: {
            email: googleUser.email,
            username: googleUser.username,
            password: null,
            emailVerified: googleUser.emailVerified,
            legalConsentVersion: CURRENT_LEGAL_CONSENT_VERSION,
            legalConsentAcceptedAt: new Date(),
            accounts: {
              create: {
                provider: 'google',
                providerAccountId: googleUser.providerAccountId,
                email: googleUser.email,
              },
            },
          },
        });
      });
    } catch (error) {
      if (
        !(error instanceof Prisma.PrismaClientKnownRequestError) ||
        error.code !== 'P2002'
      ) {
        throw error;
      }

      const account = await this.prisma.account.findUnique({
        where: {
          provider_providerAccountId: {
            provider: 'google',
            providerAccountId: googleUser.providerAccountId,
          },
        },
        include: { user: true },
      });

      if (account) {
        user = account.user;
      } else {
        const existingUser = await this.prisma.user.findUnique({
          where: { email: googleUser.email },
          select: { id: true },
        });

        if (existingUser) throw this.accountLinkRequired();
        throw error;
      }
    }

    return this.sessionService.createSession(
      user.id,
      request,
      response,
      SessionEventType.LOGIN_SUCCESS,
      rememberMe,
    );
  }

  private accountLinkRequired(): ConflictException {
    return new ConflictException({
      code: 'ACCOUNT_LINK_REQUIRED',
      message: 'Sign in with the existing account before linking Google',
    });
  }
}
