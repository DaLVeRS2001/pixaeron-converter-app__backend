import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { hash } from 'bcryptjs';
import type { Request, Response } from 'express';

import { Prisma } from '../../generated/prisma/client';

import { AuthService } from './auth.service';
import { CURRENT_LEGAL_CONSENT_VERSION } from './legal-consent.constants';

describe('AuthService captcha policy', () => {
  const prisma = {
    $transaction: jest.fn(),
    account: { findUnique: jest.fn() },
    user: { findUnique: jest.fn() },
  };
  const userService = {
    createUser: jest.fn(),
    getUser: jest.fn(),
    hashPassword: jest.fn(),
  };
  const sessionService = {
    createSession: jest.fn(),
    completePasswordChange: jest.fn(),
  };
  const sessionAuditService = {
    recordLoginFailed: jest.fn(),
    recordSecurityEvent: jest.fn(),
  };
  const captchaService = { isEnabled: jest.fn(), verify: jest.fn() };
  const googleAuthService = { verifyIdToken: jest.fn() };
  const authTokenService = { find: jest.fn(), issue: jest.fn() };
  const transactionalEmailService = {
    assertAvailable: jest.fn(),
    sendEmailVerification: jest.fn(),
    sendPasswordReset: jest.fn(),
  };
  const emailActionAttemptService = {
    assertAllowed: jest.fn(),
    isCaptchaRequired: jest.fn(),
    reserve: jest.fn(),
    startCooldown: jest.fn(),
  };
  const loginAttemptService = {
    assertAllowed: jest.fn(),
    isCaptchaRequired: jest.fn(),
    recordFailure: jest.fn(),
    clear: jest.fn(),
  };
  const request = {} as Request;
  const response = {} as Response;
  const authenticatedUser = {
    id: 1,
    email: 'user@example.com',
    username: 'user',
    emailVerified: true,
  };
  let passwordHash: string;
  let service: AuthService;

  beforeAll(async () => {
    passwordHash = await hash('correct-password', 4);
  });

  beforeEach(() => {
    jest.clearAllMocks();
    captchaService.isEnabled.mockReturnValue(true);
    loginAttemptService.assertAllowed.mockResolvedValue(undefined);
    loginAttemptService.isCaptchaRequired.mockResolvedValue(false);
    loginAttemptService.clear.mockResolvedValue(undefined);
    userService.getUser.mockResolvedValue({
      ...authenticatedUser,
      password: passwordHash,
    });
    sessionService.createSession.mockResolvedValue(authenticatedUser);
    emailActionAttemptService.assertAllowed.mockResolvedValue(undefined);
    emailActionAttemptService.isCaptchaRequired.mockResolvedValue(false);
    emailActionAttemptService.reserve.mockResolvedValue(undefined);
    emailActionAttemptService.startCooldown.mockResolvedValue(undefined);

    service = new AuthService(
      prisma as never,
      userService as never,
      sessionService as never,
      sessionAuditService as never,
      captchaService as never,
      googleAuthService as never,
      loginAttemptService as never,
      authTokenService as never,
      transactionalEmailService as never,
      emailActionAttemptService as never,
    );
  });

  it.each([
    { accepted: undefined, version: undefined },
    { accepted: false, version: CURRENT_LEGAL_CONSENT_VERSION },
    { accepted: true, version: '2026-07-25' },
  ])(
    'rejects email account creation without the current legal consent',
    async ({ accepted, version }) => {
      await expect(
        service.register(
          {
            email: 'new@example.com',
            username: 'new-user',
            password: 'Strong-password-123!',
            legalConsentAccepted: accepted,
            legalConsentVersion: version,
          },
          request,
        ),
      ).rejects.toMatchObject({
        response: expect.objectContaining({
          code: 'LEGAL_CONSENT_REQUIRED',
          action: 'accept_legal_terms',
        }),
      });

      expect(captchaService.verify).not.toHaveBeenCalled();
      expect(userService.createUser).not.toHaveBeenCalled();
    },
  );

  it('persists the current legal consent when registering by email', async () => {
    const createdUser = {
      id: 2,
      email: 'new@example.com',
      username: 'new-user',
      emailVerified: false,
    };
    userService.getUser.mockResolvedValue(null);
    userService.createUser.mockResolvedValue(createdUser);
    authTokenService.issue.mockResolvedValue('verification-token');
    transactionalEmailService.sendEmailVerification.mockResolvedValue({
      provider: 'ses',
      messageId: 'ses-message-id',
    });

    await expect(
      service.register(
        {
          email: 'new@example.com',
          username: 'new-user',
          password: 'Strong-password-123!',
          legalConsentAccepted: true,
          legalConsentVersion: CURRENT_LEGAL_CONSENT_VERSION,
          captchaToken: 'captcha-token',
        },
        request,
      ),
    ).resolves.toEqual({ accepted: true, email: 'new@example.com' });

    expect(userService.createUser).toHaveBeenCalledWith({
      email: 'new@example.com',
      username: 'new-user',
      password: 'Strong-password-123!',
      legalConsentVersion: CURRENT_LEGAL_CONSENT_VERSION,
      legalConsentAcceptedAt: expect.any(Date),
    });
  });

  it('rejects an unverified Google email before account linking', async () => {
    captchaService.verify.mockResolvedValue(undefined);
    googleAuthService.verifyIdToken.mockResolvedValue({
      providerAccountId: 'google-account',
      email: 'user@example.com',
      emailVerified: false,
      username: 'user',
    });

    await expect(
      service.googleLogin(
        { idToken: 'google-id-token', captchaToken: 'turnstile-token' },
        request,
        response,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);

    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(sessionService.createSession).not.toHaveBeenCalled();
  });

  it('does not require captcha before the failed-password threshold', async () => {
    await expect(
      service.login(
        {
          email: ' USER@example.com ',
          password: 'correct-password',
        },
        request,
        response,
      ),
    ).resolves.toEqual(authenticatedUser);

    expect(captchaService.verify).not.toHaveBeenCalled();
    expect(loginAttemptService.clear).toHaveBeenCalledWith(
      'user@example.com',
      request,
    );
  });

  it('returns CAPTCHA_REQUIRED without checking the password after the threshold', async () => {
    loginAttemptService.isCaptchaRequired.mockResolvedValue(true);

    const result = service.login(
      { email: 'user@example.com', password: 'correct-password' },
      request,
      response,
    );

    await expect(result).rejects.toBeInstanceOf(BadRequestException);
    await expect(result).rejects.toMatchObject({
      response: expect.objectContaining({
        code: 'CAPTCHA_REQUIRED',
        action: 'login',
      }),
    });
    expect(userService.getUser).not.toHaveBeenCalled();
  });

  it('verifies a supplied token before checking credentials', async () => {
    loginAttemptService.isCaptchaRequired.mockResolvedValue(true);
    captchaService.verify.mockResolvedValue(undefined);

    await service.login(
      {
        email: 'user@example.com',
        password: 'correct-password',
        captchaToken: 'turnstile-token',
      },
      request,
      response,
    );

    expect(captchaService.verify).toHaveBeenCalledWith(
      'turnstile-token',
      request,
      'login',
    );
    expect(userService.getUser).toHaveBeenCalled();
  });

  it('asks for captcha on the failure that reaches the threshold', async () => {
    loginAttemptService.recordFailure.mockResolvedValue({
      pairAttempts: 3,
      ipAttempts: 3,
      captchaRequired: true,
    });

    const result = service.login(
      { email: 'user@example.com', password: 'wrong-password' },
      request,
      response,
    );

    await expect(result).rejects.toMatchObject({
      response: expect.objectContaining({
        code: 'CAPTCHA_REQUIRED',
        action: 'login',
      }),
    });
    expect(sessionAuditService.recordLoginFailed).toHaveBeenCalled();
    expect(loginAttemptService.assertAllowed).toHaveBeenCalledTimes(2);
  });

  it('returns a login block before another captcha challenge', async () => {
    loginAttemptService.recordFailure.mockResolvedValue({
      pairAttempts: 5,
      ipAttempts: 5,
      captchaRequired: true,
    });
    loginAttemptService.assertAllowed
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(
        new HttpException(
          { code: 'TOO_MANY_LOGIN_ATTEMPTS', retryAfter: 900 },
          HttpStatus.TOO_MANY_REQUESTS,
        ),
      );

    await expect(
      service.login(
        { email: 'user@example.com', password: 'wrong-password' },
        request,
        response,
      ),
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        code: 'TOO_MANY_LOGIN_ATTEMPTS',
      }),
    });
  });
  it('does not clear failed-login state until the email verification gate passes', async () => {
    userService.getUser.mockResolvedValue({
      ...authenticatedUser,
      emailVerified: false,
      password: passwordHash,
    });

    await expect(
      service.login(
        { email: 'user@example.com', password: 'correct-password' },
        request,
        response,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);

    expect(loginAttemptService.clear).not.toHaveBeenCalled();
    expect(sessionService.createSession).not.toHaveBeenCalled();
  });

  it('consumes a reset token, changes the password, and revokes sessions in one transaction', async () => {
    const transaction = {
      authToken: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      user: { update: jest.fn().mockResolvedValue({}) },
      session: { updateMany: jest.fn().mockResolvedValue({ count: 3 }) },
    };
    authTokenService.find.mockResolvedValue({
      id: 'reset-token-id',
      userId: 1,
      consumedAt: null,
      expiresAt: new Date(Date.now() + 60_000),
      user: authenticatedUser,
    });
    userService.hashPassword.mockResolvedValue('next-password-hash');
    prisma.$transaction.mockImplementation((callback) => callback(transaction));

    await expect(
      service.resetPassword(
        { token: 'raw-token', password: 'new-password' },
        request,
        response,
      ),
    ).resolves.toEqual({ status: 'RESET' });

    expect(transaction.user.update).toHaveBeenCalledWith({
      where: { id: 1 },
      data: { password: 'next-password-hash' },
    });
    expect(transaction.session.updateMany).toHaveBeenCalledWith({
      where: { userId: 1, revokedAt: null },
      data: {
        revokedAt: expect.any(Date),
        revokedReason: 'PASSWORD_CHANGED',
      },
    });
    expect(sessionService.completePasswordChange).toHaveBeenCalledWith(
      1,
      request,
      response,
      3,
    );
  });

  it('does not change or revoke anything when a concurrent reset consumes the token first', async () => {
    const transaction = {
      authToken: {
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      user: { update: jest.fn() },
      session: { updateMany: jest.fn() },
    };
    authTokenService.find.mockResolvedValue({
      id: 'reset-token-id',
      userId: 1,
      consumedAt: null,
      expiresAt: new Date(Date.now() + 60_000),
      user: authenticatedUser,
    });
    userService.hashPassword.mockResolvedValue('next-password-hash');
    prisma.$transaction.mockImplementation((callback) => callback(transaction));

    await expect(
      service.resetPassword(
        { token: 'raw-token', password: 'new-password' },
        request,
        response,
      ),
    ).resolves.toEqual({ status: 'ALREADY_USED' });

    expect(transaction.user.update).not.toHaveBeenCalled();
    expect(transaction.session.updateMany).not.toHaveBeenCalled();
    expect(sessionService.completePasswordChange).not.toHaveBeenCalled();
  });
  it('records SES acceptance with the provider message ID, not as delivery', async () => {
    captchaService.isEnabled.mockReturnValue(false);
    authTokenService.issue.mockResolvedValue('raw-reset-token');
    transactionalEmailService.sendPasswordReset.mockResolvedValue({
      provider: 'ses',
      messageId: 'ses-message-id',
    });

    await expect(
      service.requestPasswordReset({ email: 'user@example.com' }, request),
    ).resolves.toEqual({ accepted: true });

    expect(sessionAuditService.recordSecurityEvent).toHaveBeenCalledWith(
      'PASSWORD_RESET_ACCEPTED',
      request,
      1,
      { provider: 'ses', providerMessageId: 'ses-message-id' },
    );
    expect(emailActionAttemptService.reserve).toHaveBeenCalledWith(
      'forgot_password',
      'user@example.com',
      request,
    );
  });
  it('requires explicit re-auth linking when a new Google sub matches a local email', async () => {
    const transaction = {
      account: { findUnique: jest.fn().mockResolvedValue(null) },
      user: {
        findUnique: jest.fn().mockResolvedValue({
          ...authenticatedUser,
          password: passwordHash,
        }),
        create: jest.fn(),
      },
    };
    googleAuthService.verifyIdToken.mockResolvedValue({
      providerAccountId: 'new-google-sub',
      email: 'user@example.com',
      emailVerified: true,
      username: 'user',
    });
    prisma.$transaction.mockImplementation((callback) => callback(transaction));

    await expect(
      service.googleLogin(
        { idToken: 'google-token', captchaToken: 'captcha-token' },
        request,
        response,
      ),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'ACCOUNT_LINK_REQUIRED' }),
    });

    expect(transaction.user.create).not.toHaveBeenCalled();
    expect(sessionService.createSession).not.toHaveBeenCalled();
  });

  it('logs in through an existing Google provider account', async () => {
    const transaction = {
      account: {
        findUnique: jest.fn().mockResolvedValue({ user: authenticatedUser }),
      },
      user: { findUnique: jest.fn(), create: jest.fn() },
    };
    googleAuthService.verifyIdToken.mockResolvedValue({
      providerAccountId: 'known-google-sub',
      email: 'user@example.com',
      emailVerified: true,
      username: 'user',
    });
    prisma.$transaction.mockImplementation((callback) => callback(transaction));

    await service.googleLogin(
      { idToken: 'google-token', captchaToken: 'captcha-token' },
      request,
      response,
    );

    expect(transaction.user.findUnique).not.toHaveBeenCalled();
    expect(sessionService.createSession).toHaveBeenCalledWith(
      1,
      request,
      response,
      'LOGIN_SUCCESS',
      false,
    );
  });

  it('requires current legal consent before creating a new Google account', async () => {
    const transaction = {
      account: { findUnique: jest.fn().mockResolvedValue(null) },
      user: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
    };
    googleAuthService.verifyIdToken.mockResolvedValue({
      providerAccountId: 'new-google-sub',
      email: 'new@example.com',
      emailVerified: true,
      username: 'new-user',
    });
    prisma.$transaction.mockImplementation((callback) => callback(transaction));

    await expect(
      service.googleLogin(
        { idToken: 'google-token', captchaToken: 'captcha-token' },
        request,
        response,
      ),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'LEGAL_CONSENT_REQUIRED' }),
    });

    expect(transaction.user.create).not.toHaveBeenCalled();
    expect(sessionService.createSession).not.toHaveBeenCalled();
  });

  it('creates a new account only when neither the Google sub nor email exists', async () => {
    const googleUser = {
      id: 2,
      email: 'new@example.com',
      username: 'new-user',
      emailVerified: true,
    };
    const transaction = {
      account: { findUnique: jest.fn().mockResolvedValue(null) },
      user: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue(googleUser),
      },
    };
    googleAuthService.verifyIdToken.mockResolvedValue({
      providerAccountId: 'new-google-sub',
      email: googleUser.email,
      emailVerified: true,
      username: googleUser.username,
    });
    prisma.$transaction.mockImplementation((callback) => callback(transaction));

    await service.googleLogin(
      {
        idToken: 'google-token',
        captchaToken: 'captcha-token',
        legalConsentAccepted: true,
        legalConsentVersion: CURRENT_LEGAL_CONSENT_VERSION,
      },
      request,
      response,
    );

    expect(transaction.user.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        email: googleUser.email,
        password: null,
        legalConsentVersion: CURRENT_LEGAL_CONSENT_VERSION,
        legalConsentAcceptedAt: expect.any(Date),
        accounts: {
          create: expect.objectContaining({
            provider: 'google',
            providerAccountId: 'new-google-sub',
          }),
        },
      }),
    });
    expect(sessionService.createSession).toHaveBeenCalledWith(
      2,
      request,
      response,
      'LOGIN_SUCCESS',
      false,
    );
  });

  it('recovers an existing provider after a concurrent create loses its unique race', async () => {
    prisma.$transaction.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('Unique constraint', {
        code: 'P2002',
        clientVersion: '7.8.0',
      }),
    );
    prisma.account.findUnique.mockResolvedValue({ user: authenticatedUser });
    googleAuthService.verifyIdToken.mockResolvedValue({
      providerAccountId: 'known-google-sub',
      email: 'user@example.com',
      emailVerified: true,
      username: 'user',
    });

    await service.googleLogin(
      { idToken: 'google-token', captchaToken: 'captcha-token' },
      request,
      response,
    );

    expect(sessionService.createSession).toHaveBeenCalledWith(
      1,
      request,
      response,
      'LOGIN_SUCCESS',
      false,
    );
  });
});
