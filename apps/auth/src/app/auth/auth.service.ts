import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { CaptchaService } from '@pixaeron/captcha';
import { compare, hash } from 'bcryptjs';
import type { Request, Response } from 'express';

import {
  AuthTokenType,
  Prisma,
  SessionEventType,
  SessionRevokedReason,
} from '../../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { SessionAuditService } from '../session/audit/session-audit.service';
import { SessionService } from '../session/services/session.service';
import { UserService } from '../user/user.service';
import { AuthTokenService } from './auth-token.service';
import { AuthTokenInput } from './dto/auth-token.input';
import { EmailActionInput } from './dto/email-action.input';
import { GoogleLoginInput } from './dto/google-login.input';
import { LoginInput } from './dto/login.input';
import { RegisterInput } from './dto/register.input';
import { ResetPasswordInput } from './dto/reset-password.input';
import {
  EmailAction,
  EmailActionAttemptService,
} from './email-action-attempt.service';
import { GoogleAuthService } from './google-auth.service';
import {
  CURRENT_LEGAL_CONSENT_VERSION,
  LEGAL_CONSENT_REQUIRED_ERROR,
} from './legal-consent.constants';
import { LoginAttemptService } from './login-attempt.service';
import {
  AuthRequestResult,
  EmailVerificationResult,
  EmailVerificationStatus,
  PasswordResetResult,
  PasswordResetStatus,
  RegistrationResult,
} from './models/auth-result.model';
import { TransactionalEmailService } from './transactional-email.service';

const DUMMY_PASSWORD_HASH = hash('pixaeron-dummy-password-not-valid', 12);

@Injectable()
export class AuthService {
  private readonly invalidCredentialsMessage = 'Invalid email or password';

  constructor(
    private readonly prisma: PrismaService,
    private readonly userService: UserService,
    private readonly sessionService: SessionService,
    private readonly sessionAuditService: SessionAuditService,
    private readonly captchaService: CaptchaService,
    private readonly googleAuthService: GoogleAuthService,
    private readonly loginAttemptService: LoginAttemptService,
    private readonly authTokenService: AuthTokenService,
    private readonly transactionalEmailService: TransactionalEmailService,
    private readonly emailActionAttemptService: EmailActionAttemptService,
  ) {}

  async login(
    { email, password, rememberMe = false, captchaToken }: LoginInput,
    request: Request,
    response: Response,
  ) {
    const normalizedEmail = this.normalizeEmail(email);
    await this.loginAttemptService.assertAllowed(normalizedEmail, request);

    if (
      this.captchaService.isEnabled() &&
      (await this.loginAttemptService.isCaptchaRequired(
        normalizedEmail,
        request,
      ))
    ) {
      await this.requireCaptcha(captchaToken, request, 'login');
    }

    const user = await this.userService.getUser({ email: normalizedEmail });

    if (!user?.password) {
      await compare(password, await DUMMY_PASSWORD_HASH);
      return this.rejectInvalidCredentials(normalizedEmail, request, user?.id);
    }

    const isPasswordValid = await compare(password, user.password);

    if (!isPasswordValid) {
      return this.rejectInvalidCredentials(normalizedEmail, request, user.id);
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

    await this.loginAttemptService.clear(normalizedEmail, request);

    return this.sessionService.createSession(
      user.id,
      request,
      response,
      SessionEventType.LOGIN_SUCCESS,
      rememberMe,
    );
  }

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
    this.assertLegalConsent(legalConsentAccepted, legalConsentVersion);
    this.transactionalEmailService.assertAvailable();
    await this.requireCaptcha(captchaToken, request, 'register');

    const normalizedEmail = this.normalizeEmail(email);
    const existingUser = await this.userService.getUser({
      email: normalizedEmail,
    });

    if (existingUser) {
      throw new ConflictException({
        code: 'EMAIL_ALREADY_REGISTERED',
        message: 'An account with this email already exists',
      });
    }

    let user;

    try {
      user = await this.userService.createUser({
        email: normalizedEmail,
        username: username.trim(),
        password,
        legalConsentVersion: CURRENT_LEGAL_CONSENT_VERSION,
        legalConsentAcceptedAt: new Date(),
      });
    } catch (error) {
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
    }

    await this.sessionAuditService.recordSecurityEvent(
      SessionEventType.REGISTER_SUCCESS,
      request,
      user.id,
    );
    await this.sendEmailVerification(user.id, user.email, request);

    return { accepted: true, email: user.email };
  }

  async resendEmailVerification(
    { email, captchaToken }: EmailActionInput,
    request: Request,
  ): Promise<AuthRequestResult> {
    this.transactionalEmailService.assertAvailable();
    const normalizedEmail = this.normalizeEmail(email);
    await this.prepareEmailAction(
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
      await this.sendEmailVerification(user.id, user.email, request);
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
    const authToken = await this.authTokenService.find(
      token,
      AuthTokenType.EMAIL_VERIFICATION,
    );

    if (!authToken) {
      await this.sessionAuditService.recordSecurityEvent(
        SessionEventType.EMAIL_VERIFICATION_INVALID,
        request,
      );
      return { status: EmailVerificationStatus.INVALID };
    }

    if (authToken.user.emailVerified) {
      await this.prisma.authToken.updateMany({
        where: { id: authToken.id, consumedAt: null },
        data: { consumedAt: new Date() },
      });
      await this.sessionAuditService.recordSecurityEvent(
        SessionEventType.EMAIL_ALREADY_VERIFIED,
        request,
        authToken.userId,
      );
      return { status: EmailVerificationStatus.ALREADY_VERIFIED };
    }

    if (authToken.consumedAt) {
      await this.sessionAuditService.recordSecurityEvent(
        SessionEventType.EMAIL_VERIFICATION_INVALID,
        request,
        authToken.userId,
      );
      return { status: EmailVerificationStatus.INVALID };
    }

    const now = new Date();

    if (authToken.expiresAt <= now) {
      await this.sessionAuditService.recordSecurityEvent(
        SessionEventType.EMAIL_VERIFICATION_EXPIRED,
        request,
        authToken.userId,
      );
      return { status: EmailVerificationStatus.EXPIRED };
    }

    const verified = await this.prisma.$transaction(async (transaction) => {
      const consumed = await transaction.authToken.updateMany({
        where: {
          id: authToken.id,
          consumedAt: null,
          expiresAt: { gt: now },
        },
        data: { consumedAt: now },
      });

      if (consumed.count !== 1) return false;

      await transaction.user.update({
        where: { id: authToken.userId },
        data: { emailVerified: true },
      });

      return true;
    });

    if (!verified) {
      return { status: EmailVerificationStatus.INVALID };
    }

    await this.sessionAuditService.recordSecurityEvent(
      SessionEventType.EMAIL_VERIFIED,
      request,
      authToken.userId,
    );

    return { status: EmailVerificationStatus.VERIFIED };
  }

  async requestPasswordReset(
    { email, captchaToken }: EmailActionInput,
    request: Request,
  ): Promise<AuthRequestResult> {
    this.transactionalEmailService.assertAvailable();
    const normalizedEmail = this.normalizeEmail(email);
    await this.prepareEmailAction(
      'forgot_password',
      normalizedEmail,
      captchaToken,
      request,
    );

    const user = await this.userService.getUser({ email: normalizedEmail });
    await this.sessionAuditService.recordSecurityEvent(
      SessionEventType.PASSWORD_RESET_REQUESTED,
      request,
      user?.id,
    );

    if (user?.password) {
      const token = await this.authTokenService.issue(
        user.id,
        AuthTokenType.PASSWORD_RESET,
      );

      try {
        const receipt = await this.transactionalEmailService.sendPasswordReset(
          user.email,
          token,
        );
        await this.sessionAuditService.recordSecurityEvent(
          SessionEventType.PASSWORD_RESET_ACCEPTED,
          request,
          user.id,
          {
            provider: receipt.provider,
            providerMessageId: receipt.messageId,
          },
        );
      } catch {
        await this.sessionAuditService.recordSecurityEvent(
          SessionEventType.PASSWORD_RESET_FAILED,
          request,
          user.id,
          { reason: 'delivery_failed' },
        );
      }
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

    const now = new Date();

    if (authToken.expiresAt <= now) {
      await this.sessionAuditService.recordSecurityEvent(
        SessionEventType.PASSWORD_RESET_EXPIRED,
        request,
        authToken.userId,
      );
      return { status: PasswordResetStatus.EXPIRED };
    }

    const passwordHash = await this.userService.hashPassword(password);
    const reset = await this.prisma.$transaction(async (transaction) => {
      const consumed = await transaction.authToken.updateMany({
        where: {
          id: authToken.id,
          consumedAt: null,
          expiresAt: { gt: now },
        },
        data: { consumedAt: now },
      });

      if (consumed.count !== 1) return null;

      await transaction.user.update({
        where: { id: authToken.userId },
        data: { password: passwordHash },
      });
      const revokedSessions = await transaction.session.updateMany({
        where: { userId: authToken.userId, revokedAt: null },
        data: {
          revokedAt: now,
          revokedReason: SessionRevokedReason.PASSWORD_CHANGED,
        },
      });

      return { revokedSessions: revokedSessions.count };
    });

    if (!reset) return { status: PasswordResetStatus.ALREADY_USED };

    await this.sessionService.completePasswordChange(
      authToken.userId,
      request,
      response,
      reset.revokedSessions,
    );
    await this.sessionAuditService.recordSecurityEvent(
      SessionEventType.PASSWORD_RESET_COMPLETED,
      request,
      authToken.userId,
    );

    return { status: PasswordResetStatus.RESET };
  }

  async googleLogin(
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
    await this.requireCaptcha(captchaToken, request, 'google_login');

    const googleUser = await this.googleAuthService.verifyIdToken(idToken);

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

        this.assertLegalConsent(legalConsentAccepted, legalConsentVersion);

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

  async logout(request: Request, response: Response) {
    return this.sessionService.logout(request, response);
  }

  async logoutAll(userId: number, request: Request, response: Response) {
    return this.sessionService.logoutAll(userId, request, response);
  }

  private async sendEmailVerification(
    userId: number,
    email: string,
    request: Request,
  ): Promise<void> {
    await this.sessionAuditService.recordSecurityEvent(
      SessionEventType.EMAIL_VERIFICATION_REQUESTED,
      request,
      userId,
    );
    await this.emailActionAttemptService.startCooldown(
      'resend_confirmation',
      email,
      request,
    );
    const token = await this.authTokenService.issue(
      userId,
      AuthTokenType.EMAIL_VERIFICATION,
    );

    try {
      const receipt =
        await this.transactionalEmailService.sendEmailVerification(
          email,
          token,
        );
      await this.sessionAuditService.recordSecurityEvent(
        SessionEventType.EMAIL_VERIFICATION_ACCEPTED,
        request,
        userId,
        {
          provider: receipt.provider,
          providerMessageId: receipt.messageId,
        },
      );
    } catch {
      await this.sessionAuditService.recordSecurityEvent(
        SessionEventType.EMAIL_VERIFICATION_FAILED,
        request,
        userId,
        { reason: 'delivery_failed' },
      );
    }
  }

  private async prepareEmailAction(
    action: EmailAction,
    email: string,
    captchaToken: string | undefined,
    request: Request,
  ): Promise<void> {
    await this.emailActionAttemptService.assertAllowed(action, email, request);

    if (
      this.captchaService.isEnabled() &&
      (await this.emailActionAttemptService.isCaptchaRequired(
        action,
        email,
        request,
      ))
    ) {
      await this.requireCaptcha(captchaToken, request, action);
    }

    await this.emailActionAttemptService.reserve(action, email, request);
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

    if (this.captchaService.isEnabled() && attempt.captchaRequired) {
      throw new BadRequestException({
        code: 'CAPTCHA_REQUIRED',
        action: 'login',
        message: 'Captcha verification is required',
      });
    }

    throw new UnauthorizedException(this.invalidCredentialsMessage);
  }

  private async requireCaptcha(
    token: string | undefined,
    request: Request,
    action: string,
  ): Promise<void> {
    if (!this.captchaService.isEnabled()) return;

    if (!token) {
      throw new BadRequestException({
        code: 'CAPTCHA_REQUIRED',
        action,
        message: 'Captcha verification is required',
      });
    }

    await this.captchaService.verify(token, request, action);
  }

  private accountLinkRequired(): ConflictException {
    return new ConflictException({
      code: 'ACCOUNT_LINK_REQUIRED',
      message: 'Sign in with the existing account before linking Google',
    });
  }
  private assertLegalConsent(
    accepted: boolean | undefined,
    version: string | undefined,
  ): void {
    if (accepted !== true || version !== CURRENT_LEGAL_CONSENT_VERSION) {
      throw new BadRequestException(LEGAL_CONSENT_REQUIRED_ERROR);
    }
  }

  private normalizeEmail(email: string): string {
    return email.trim().toLowerCase();
  }
}
