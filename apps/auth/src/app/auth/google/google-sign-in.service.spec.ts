import { ForbiddenException } from '@nestjs/common';
import type { Request, Response } from 'express';

import { Prisma } from '../../../generated/prisma/client';
import { CURRENT_LEGAL_CONSENT_VERSION } from '../constants/legal-consent.constants';
import { GoogleSignInService } from './google-sign-in.service';

describe('GoogleSignInService', () => {
  const prisma = {
    $transaction: jest.fn(),
    account: { findUnique: jest.fn() },
    user: { findUnique: jest.fn() },
  };
  const sessionService = { createSession: jest.fn() };
  const googleAuthService = { verifyIdToken: jest.fn() };
  const challengePolicy = { requireCaptcha: jest.fn() };
  const request = {} as Request;
  const response = {} as Response;
  const authenticatedUser = {
    id: 1,
    email: 'user@example.com',
    username: 'user',
    emailVerified: true,
  };
  let service: GoogleSignInService;

  beforeEach(() => {
    jest.clearAllMocks();
    challengePolicy.requireCaptcha.mockResolvedValue(undefined);
    sessionService.createSession.mockResolvedValue(authenticatedUser);
    service = new GoogleSignInService(
      prisma as never,
      sessionService as never,
      googleAuthService as never,
      challengePolicy as never,
    );
  });

  it('rejects an unverified Google email before account lookup', async () => {
    googleAuthService.verifyIdToken.mockResolvedValue({
      providerAccountId: 'google-account',
      email: 'user@example.com',
      emailVerified: false,
      username: 'user',
    });

    await expect(
      service.login(
        { idToken: 'google-id-token', captchaToken: 'turnstile-token' },
        request,
        response,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);

    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(sessionService.createSession).not.toHaveBeenCalled();
  });

  it('requires explicit re-auth linking when a new Google sub matches a local email', async () => {
    const transaction = {
      account: { findUnique: jest.fn().mockResolvedValue(null) },
      user: {
        findUnique: jest.fn().mockResolvedValue(authenticatedUser),
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
      service.login(
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

    await service.login(
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

  it('requires current legal consent before creating a Google account', async () => {
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
      service.login(
        { idToken: 'google-token', captchaToken: 'captcha-token' },
        request,
        response,
      ),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'LEGAL_CONSENT_REQUIRED' }),
    });

    expect(transaction.user.create).not.toHaveBeenCalled();
  });

  it('creates an account only when neither Google sub nor email exists', async () => {
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

    await service.login(
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

  it('recovers an existing provider after a concurrent unique race', async () => {
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

    await service.login(
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
