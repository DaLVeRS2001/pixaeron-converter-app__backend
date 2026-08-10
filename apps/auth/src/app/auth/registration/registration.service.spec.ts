import type { Request } from 'express';

import { Prisma } from '../../../generated/prisma/client';
import { CURRENT_LEGAL_CONSENT_VERSION } from '../constants/legal-consent.constants';
import { RegistrationService } from './registration.service';

describe('RegistrationService', () => {
  const prisma = { $transaction: jest.fn() };
  const userService = {
    createLocalUserInTransaction: jest.fn(),
    getUser: jest.fn(),
    hashPassword: jest.fn(),
  };
  const sessionAuditService = { recordSecurityEvent: jest.fn() };
  const authTokenService = {
    findInTransaction: jest.fn(),
    issueInTransaction: jest.fn(),
  };
  const challengePolicy = {
    requireCaptcha: jest.fn(),
    prepareEmailAction: jest.fn(),
  };
  const emailDelivery = {
    assertAvailable: jest.fn(),
    runGenericEmailAction: jest.fn(),
    sendEmailVerificationAfterCommit: jest.fn(),
  };
  const request = {} as Request;
  const authenticatedUser = {
    id: 1,
    publicId: '0198f687-15d8-7f5e-bd79-62f8f4d51e07',
    email: 'user@example.com',
    username: 'user',
    emailVerified: true,
  };
  let service: RegistrationService;

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.$transaction.mockImplementation((callback) => callback({}));
    userService.getUser.mockResolvedValue(null);
    userService.hashPassword.mockResolvedValue('generated-password-hash');
    authTokenService.issueInTransaction.mockResolvedValue('issued-token');
    challengePolicy.requireCaptcha.mockResolvedValue(undefined);
    challengePolicy.prepareEmailAction.mockResolvedValue(undefined);
    emailDelivery.runGenericEmailAction.mockImplementation((action) =>
      action(),
    );
    emailDelivery.sendEmailVerificationAfterCommit.mockResolvedValue(undefined);
    sessionAuditService.recordSecurityEvent.mockResolvedValue(undefined);

    service = new RegistrationService(
      prisma as never,
      userService as never,
      sessionAuditService as never,
      authTokenService as never,
      challengePolicy as never,
      emailDelivery as never,
    );
  });

  it('creates the user, verification token, and required audits in one transaction', async () => {
    const transaction = {};
    const createdUser = {
      id: 2,
      publicId: '0198f687-15d8-7f5e-bd79-62f8f4d51e08',
      email: 'new@example.com',
      username: 'new-user',
      emailVerified: false,
    };
    userService.createLocalUserInTransaction.mockResolvedValue(createdUser);
    userService.hashPassword.mockResolvedValue('registration-password-hash');
    authTokenService.issueInTransaction.mockResolvedValue('verification-token');
    prisma.$transaction.mockImplementation((callback) => callback(transaction));

    await expect(
      service.register(
        {
          email: ' NEW@example.com ',
          username: ' new-user ',
          password: 'Strong-password-123!',
          legalConsentAccepted: true,
          legalConsentVersion: CURRENT_LEGAL_CONSENT_VERSION,
          captchaToken: 'captcha-token',
        },
        request,
      ),
    ).resolves.toEqual({ accepted: true, email: 'new@example.com' });

    expect(userService.createLocalUserInTransaction).toHaveBeenCalledWith(
      transaction,
      {
        email: 'new@example.com',
        username: 'new-user',
        passwordHash: 'registration-password-hash',
        legalConsentVersion: CURRENT_LEGAL_CONSENT_VERSION,
        legalConsentAcceptedAt: expect.any(Date),
      },
    );
    expect(authTokenService.issueInTransaction).toHaveBeenCalledWith(
      transaction,
      2,
      'EMAIL_VERIFICATION',
    );
    expect(sessionAuditService.recordSecurityEvent).toHaveBeenCalledWith(
      'REGISTER_SUCCESS',
      request,
      2,
      undefined,
      transaction,
    );
    expect(sessionAuditService.recordSecurityEvent).toHaveBeenCalledWith(
      'EMAIL_VERIFICATION_REQUESTED',
      request,
      2,
      undefined,
      transaction,
    );
    expect(emailDelivery.sendEmailVerificationAfterCommit).toHaveBeenCalledWith(
      {
        userId: 2,
        publicSubject: '0198f687-15d8-7f5e-bd79-62f8f4d51e08',
        recipient: 'new@example.com',
        token: 'verification-token',
        request,
      },
      true,
    );
  });

  it('maps a concurrent registration unique race without external effects', async () => {
    prisma.$transaction.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('Unique constraint', {
        code: 'P2002',
        clientVersion: '7.8.0',
      }),
    );

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
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'EMAIL_ALREADY_REGISTERED' }),
    });

    expect(
      emailDelivery.sendEmailVerificationAfterCommit,
    ).not.toHaveBeenCalled();
  });

  it('does not deliver email when registration local state rolls back', async () => {
    const state = { user: false, token: false };
    const transaction = {};
    userService.createLocalUserInTransaction.mockImplementation(async () => {
      state.user = true;
      return {
        id: 2,
        email: 'new@example.com',
        username: 'new-user',
        emailVerified: false,
      };
    });
    authTokenService.issueInTransaction.mockImplementation(async () => {
      state.token = true;
      return 'verification-token';
    });
    sessionAuditService.recordSecurityEvent.mockImplementation(async (type) => {
      if (type === 'EMAIL_VERIFICATION_REQUESTED') {
        throw new Error('audit unavailable');
      }
    });
    prisma.$transaction.mockImplementation(async (callback) => {
      const snapshot = { ...state };
      try {
        return await callback(transaction);
      } catch (error) {
        Object.assign(state, snapshot);
        throw error;
      }
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
    ).rejects.toThrow('audit unavailable');

    expect(state).toEqual({ user: false, token: false });
    expect(
      emailDelivery.sendEmailVerificationAfterCommit,
    ).not.toHaveBeenCalled();
  });

  it('consumes verification token, updates user, and audits in one transaction', async () => {
    const transaction = {
      authToken: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      user: { update: jest.fn().mockResolvedValue({}) },
    };
    authTokenService.findInTransaction.mockResolvedValue({
      id: 'verification-token-id',
      userId: 1,
      consumedAt: null,
      expiresAt: new Date(Date.now() + 60_000),
      user: { ...authenticatedUser, emailVerified: false },
    });
    prisma.$transaction.mockImplementation((callback) => callback(transaction));

    await expect(
      service.verifyEmail({ token: 'raw-token' }, request),
    ).resolves.toEqual({ status: 'VERIFIED' });

    expect(transaction.user.update).toHaveBeenCalledWith({
      where: { id: 1 },
      data: { emailVerified: true },
    });
    expect(sessionAuditService.recordSecurityEvent).toHaveBeenCalledWith(
      'EMAIL_VERIFIED',
      request,
      1,
      undefined,
      transaction,
    );
  });

  it('rolls back verification state when the required audit fails', async () => {
    const state = { consumed: false, emailVerified: false };
    const transaction = {
      authToken: {
        updateMany: jest.fn().mockImplementation(async () => {
          state.consumed = true;
          return { count: 1 };
        }),
      },
      user: {
        update: jest.fn().mockImplementation(async () => {
          state.emailVerified = true;
        }),
      },
    };
    authTokenService.findInTransaction.mockResolvedValue({
      id: 'verification-token-id',
      userId: 1,
      consumedAt: null,
      expiresAt: new Date(Date.now() + 60_000),
      user: { ...authenticatedUser, emailVerified: false },
    });
    sessionAuditService.recordSecurityEvent.mockImplementation(async (type) => {
      if (type === 'EMAIL_VERIFIED') throw new Error('audit unavailable');
    });
    prisma.$transaction.mockImplementation(async (callback) => {
      const snapshot = { ...state };
      try {
        return await callback(transaction);
      } catch (error) {
        Object.assign(state, snapshot);
        throw error;
      }
    });

    await expect(
      service.verifyEmail({ token: 'raw-token' }, request),
    ).rejects.toThrow('audit unavailable');
    expect(state).toEqual({ consumed: false, emailVerified: false });
  });

  it('keeps resend response generic when the email does not exist', async () => {
    userService.getUser.mockResolvedValue(null);

    await expect(
      service.resendEmailVerification(
        { email: ' Missing@example.com ' },
        request,
      ),
    ).resolves.toEqual({ accepted: true });

    expect(challengePolicy.prepareEmailAction).toHaveBeenCalledWith(
      'resend_confirmation',
      'missing@example.com',
      undefined,
      request,
    );
    expect(sessionAuditService.recordSecurityEvent).toHaveBeenCalledWith(
      'EMAIL_VERIFICATION_REQUESTED',
      request,
    );
    expect(authTokenService.issueInTransaction).not.toHaveBeenCalled();
    expect(emailDelivery.runGenericEmailAction).toHaveBeenCalledWith(
      expect.any(Function),
    );
  });

  it('does not issue another token for an already verified email', async () => {
    userService.getUser.mockResolvedValue(authenticatedUser);

    await service.resendEmailVerification(
      { email: 'user@example.com' },
      request,
    );

    expect(sessionAuditService.recordSecurityEvent).toHaveBeenCalledWith(
      'EMAIL_ALREADY_VERIFIED',
      request,
      1,
    );
    expect(authTokenService.issueInTransaction).not.toHaveBeenCalled();
  });

  it('returns ALREADY_VERIFIED and consumes an active token for an already verified account', async () => {
    const transaction = {
      authToken: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    };
    authTokenService.findInTransaction.mockResolvedValue({
      id: 'verification-token-id',
      userId: 1,
      consumedAt: null,
      expiresAt: new Date(Date.now() + 60_000),
      user: authenticatedUser,
    });
    prisma.$transaction.mockImplementation((callback) => callback(transaction));

    await expect(
      service.verifyEmail({ token: 'raw-token' }, request),
    ).resolves.toEqual({ status: 'ALREADY_VERIFIED' });

    expect(transaction.authToken.updateMany).toHaveBeenCalledWith({
      where: { id: 'verification-token-id', consumedAt: null },
      data: { consumedAt: expect.any(Date) },
    });
    expect(sessionAuditService.recordSecurityEvent).toHaveBeenCalledWith(
      'EMAIL_ALREADY_VERIFIED',
      request,
      1,
      undefined,
      transaction,
    );
  });

  it('returns INVALID for a consumed verification token', async () => {
    const transaction = {
      authToken: { updateMany: jest.fn() },
      user: { update: jest.fn() },
    };
    authTokenService.findInTransaction.mockResolvedValue({
      id: 'verification-token-id',
      userId: 1,
      consumedAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
      user: { ...authenticatedUser, emailVerified: false },
    });
    prisma.$transaction.mockImplementation((callback) => callback(transaction));

    await expect(
      service.verifyEmail({ token: 'raw-token' }, request),
    ).resolves.toEqual({ status: 'INVALID' });

    expect(transaction.authToken.updateMany).not.toHaveBeenCalled();
    expect(transaction.user.update).not.toHaveBeenCalled();
    expect(sessionAuditService.recordSecurityEvent).toHaveBeenCalledWith(
      'EMAIL_VERIFICATION_INVALID',
      request,
      1,
      undefined,
      transaction,
    );
  });

  it('returns EXPIRED for an expired verification token', async () => {
    const transaction = {
      authToken: { updateMany: jest.fn() },
      user: { update: jest.fn() },
    };
    authTokenService.findInTransaction.mockResolvedValue({
      id: 'verification-token-id',
      userId: 1,
      consumedAt: null,
      expiresAt: new Date(Date.now() - 1),
      user: { ...authenticatedUser, emailVerified: false },
    });
    prisma.$transaction.mockImplementation((callback) => callback(transaction));

    await expect(
      service.verifyEmail({ token: 'raw-token' }, request),
    ).resolves.toEqual({ status: 'EXPIRED' });

    expect(transaction.authToken.updateMany).not.toHaveBeenCalled();
    expect(transaction.user.update).not.toHaveBeenCalled();
    expect(sessionAuditService.recordSecurityEvent).toHaveBeenCalledWith(
      'EMAIL_VERIFICATION_EXPIRED',
      request,
      1,
      undefined,
      transaction,
    );
  });

  it.each([
    {
      current: {
        id: 'verification-token-id',
        userId: 1,
        consumedAt: new Date(),
        expiresAt: new Date(Date.now() + 60_000),
        user: authenticatedUser,
      },
      expectedStatus: 'ALREADY_VERIFIED',
      expectedEvent: 'EMAIL_ALREADY_VERIFIED',
    },
    {
      current: null,
      expectedStatus: 'INVALID',
      expectedEvent: 'EMAIL_VERIFICATION_INVALID',
    },
  ])(
    'maps a verification CAS loser to $expectedStatus after re-reading current state',
    async ({ current, expectedStatus, expectedEvent }) => {
      const transaction = {
        authToken: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
        user: { update: jest.fn() },
      };
      const activeToken = {
        id: 'verification-token-id',
        userId: 1,
        consumedAt: null,
        expiresAt: new Date(Date.now() + 60_000),
        user: { ...authenticatedUser, emailVerified: false },
      };
      authTokenService.findInTransaction
        .mockResolvedValueOnce(activeToken)
        .mockResolvedValueOnce(current);
      prisma.$transaction.mockImplementation((callback) =>
        callback(transaction),
      );

      await expect(
        service.verifyEmail({ token: 'raw-token' }, request),
      ).resolves.toEqual({ status: expectedStatus });

      expect(transaction.user.update).not.toHaveBeenCalled();
      expect(sessionAuditService.recordSecurityEvent).toHaveBeenCalledWith(
        expectedEvent,
        request,
        1,
        undefined,
        transaction,
      );
    },
  );
});
