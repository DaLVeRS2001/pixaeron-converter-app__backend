import {
  ForbiddenException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request, Response } from 'express';

import { SessionEventType } from '../../../generated/prisma/client';
import { SessionAuditService } from '../../session/audit/session-audit.service';
import {
  SessionCredentialChangedError,
  SessionService,
} from '../../session/services/session.service';
import { UserService } from '../../user/user.service';
import { LoginInput } from './login.input';
import { normalizeEmail } from '../helpers/normalize-email';
import { AuthChallengePolicyService } from '../services/auth-challenge-policy.service';
import { LoginAttemptService } from './login-attempt.service';

@Injectable()
export class PasswordSignInService {
  private readonly logger = new Logger(PasswordSignInService.name);

  constructor(
    private readonly userService: UserService,
    private readonly sessionService: SessionService,
    private readonly sessionAuditService: SessionAuditService,
    private readonly loginAttemptService: LoginAttemptService,
    private readonly challengePolicy: AuthChallengePolicyService,
  ) {}

  async login(
    { email, password, rememberMe = false, captchaToken }: LoginInput,
    request: Request,
    response: Response,
  ) {
    const normalizedEmail = normalizeEmail(email);
    await this.loginAttemptService.assertAllowed(normalizedEmail, request);
    await this.challengePolicy.requireLoginCaptchaIfNeeded(
      normalizedEmail,
      captchaToken,
      request,
    );

    const user = await this.userService.getUser({ email: normalizedEmail });
    const passwordValid = await this.userService.verifyPassword(
      password,
      user?.password,
    );

    if (!user?.password || !passwordValid) {
      return this.rejectInvalidCredentials(normalizedEmail, request, user?.id);
    }

    if (!user.emailVerified) {
      await this.sessionAuditService.recordSecurityEvent(
        SessionEventType.LOGIN_FAILED,
        request,
        user.id,
        { reason: 'email_not_verified' },
      );
      throw new ForbiddenException({
        code: 'EMAIL_NOT_VERIFIED',
        action: 'resend_confirmation',
        message: 'Verify your email before signing in',
      });
    }

    let authenticatedUser;

    try {
      authenticatedUser = await this.sessionService.createSession(
        user.id,
        request,
        response,
        SessionEventType.LOGIN_SUCCESS,
        rememberMe,
        user.password,
      );
    } catch (error) {
      if (error instanceof SessionCredentialChangedError) {
        return this.rejectInvalidCredentials(normalizedEmail, request, user.id);
      }

      throw error;
    }

    try {
      await this.loginAttemptService.clear(normalizedEmail, request);
    } catch {
      this.logger.error(
        'Failed to clear login-attempt state after successful authentication',
      );
    }

    return authenticatedUser;
  }

  private async rejectInvalidCredentials(
    normalizedEmail: string,
    request: Request,
    userId?: number,
  ): Promise<never> {
    const attempt = await this.loginAttemptService.recordFailure(
      normalizedEmail,
      request,
    );
    await this.sessionAuditService.recordLoginFailed(request, userId);

    await this.loginAttemptService.assertAllowed(normalizedEmail, request);
    this.challengePolicy.throwIfCaptchaRequiredAfterLoginFailure(
      attempt.captchaRequired,
    );

    throw new UnauthorizedException('Invalid email or password');
  }
}
