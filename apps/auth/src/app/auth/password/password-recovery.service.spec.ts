import type { Request, Response } from 'express';

import { PasswordRecoveryService } from './password-recovery.service';

describe('PasswordRecoveryService', () => {
  const prisma = { $transaction: jest.fn() };
  const userService = { getUser: jest.fn(), hashPassword: jest.fn() };
  const sessionService = { completePasswordChange: jest.fn() };
  const sessionAuditService = {
    recordPasswordChanged: jest.fn(),
    recordSecurityEvent: jest.fn(),
  };
  const authTokenService = {
    find: jest.fn(),
    findInTransaction: jest.fn(),
    issueInTransaction: jest.fn(),
  };
  const challengePolicy = { prepareEmailAction: jest.fn() };
  const emailDelivery = {
    assertAvailable: jest.fn(),
    runGenericEmailAction: jest.fn(),
    sendPasswordResetAfterCommit: jest.fn(),
  };
  const request = {} as Request;
  const response = {} as Response;
  const user = {
    id: 1,
    publicId: '0198f687-15d8-7f5e-bd79-62f8f4d51e07',
    email: 'user@example.com',
    username: 'user',
    emailVerified: true,
    password: 'current-password-hash',
  };
  let service: PasswordRecoveryService;

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.$transaction.mockImplementation((callback) => callback({}));
    userService.getUser.mockResolvedValue(user);
    userService.hashPassword.mockResolvedValue('next-password-hash');
    sessionAuditService.recordPasswordChanged.mockResolvedValue(undefined);
    sessionAuditService.recordSecurityEvent.mockResolvedValue(undefined);
    authTokenService.issueInTransaction.mockResolvedValue('raw-reset-token');
    challengePolicy.prepareEmailAction.mockResolvedValue(undefined);
    emailDelivery.runGenericEmailAction.mockImplementation((action) =>
      action(),
    );
    emailDelivery.sendPasswordResetAfterCommit.mockResolvedValue(undefined);

    service = new PasswordRecoveryService(
      prisma as never,
      userService as never,
      sessionService as never,
      sessionAuditService as never,
      authTokenService as never,
      challengePolicy as never,
      emailDelivery as never,
    );
  });

  it('issues and audits a reset token in one transaction before delivery', async () => {
    const transaction = {};
    prisma.$transaction.mockImplementation((callback) => callback(transaction));

    await expect(
      service.requestPasswordReset({ email: ' USER@example.com ' }, request),
    ).resolves.toEqual({ accepted: true });

    expect(challengePolicy.prepareEmailAction).toHaveBeenCalledWith(
      'forgot_password',
      'user@example.com',
      undefined,
      request,
    );
    expect(authTokenService.issueInTransaction).toHaveBeenCalledWith(
      transaction,
      1,
      'PASSWORD_RESET',
    );
    expect(sessionAuditService.recordSecurityEvent).toHaveBeenCalledWith(
      'PASSWORD_RESET_REQUESTED',
      request,
      1,
      undefined,
      transaction,
    );
    expect(emailDelivery.sendPasswordResetAfterCommit).toHaveBeenCalledWith({
      userId: 1,
      publicSubject: '0198f687-15d8-7f5e-bd79-62f8f4d51e07',
      recipient: 'user@example.com',
      token: 'raw-reset-token',
      request,
    });
  });

  it.each([
    ['a passwordless account', { ...user, password: null }, 1],
    ['an unknown email', null, undefined],
  ])(
    'keeps reset requests generic for %s',
    async (_scenario, resolvedUser, expectedUserId) => {
      userService.getUser.mockResolvedValue(resolvedUser);

      await expect(
        service.requestPasswordReset({ email: user.email }, request),
      ).resolves.toEqual({ accepted: true });

      expect(authTokenService.issueInTransaction).not.toHaveBeenCalled();
      expect(emailDelivery.sendPasswordResetAfterCommit).not.toHaveBeenCalled();
      expect(sessionAuditService.recordSecurityEvent).toHaveBeenCalledWith(
        'PASSWORD_RESET_REQUESTED',
        request,
        expectedUserId,
      );
      expect(emailDelivery.runGenericEmailAction).toHaveBeenCalledWith(
        expect.any(Function),
      );
    },
  );

  it('consumes token, changes password, and revokes sessions in one transaction', async () => {
    const transaction = {
      authToken: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      user: { update: jest.fn().mockResolvedValue({}) },
      session: { updateMany: jest.fn().mockResolvedValue({ count: 3 }) },
    };
    const resetToken = {
      id: 'reset-token-id',
      userId: 1,
      consumedAt: null,
      expiresAt: new Date(Date.now() + 60_000),
      user,
    };
    authTokenService.find.mockResolvedValue(resetToken);
    authTokenService.findInTransaction.mockResolvedValue(resetToken);
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
    expect(sessionAuditService.recordPasswordChanged).toHaveBeenCalledWith(
      1,
      request,
      3,
      transaction,
    );
    expect(sessionAuditService.recordSecurityEvent).toHaveBeenCalledWith(
      'PASSWORD_RESET_COMPLETED',
      request,
      1,
      undefined,
      transaction,
    );
    expect(sessionService.completePasswordChange).toHaveBeenCalledWith(
      response,
    );
  });

  it('does not change or revoke when a concurrent reset consumes the token first', async () => {
    const transaction = {
      authToken: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
      user: { update: jest.fn() },
      session: { updateMany: jest.fn() },
    };
    const resetToken = {
      id: 'reset-token-id',
      userId: 1,
      consumedAt: null,
      expiresAt: new Date(Date.now() + 60_000),
      user,
    };
    authTokenService.find.mockResolvedValue(resetToken);
    authTokenService.findInTransaction.mockResolvedValue(resetToken);
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

  it('rolls back password, revocations, and token consumption when audit fails', async () => {
    const state = { consumed: false, password: 'old-hash', revoked: false };
    const transaction = {
      authToken: {
        updateMany: jest.fn().mockImplementation(async () => {
          state.consumed = true;
          return { count: 1 };
        }),
      },
      user: {
        update: jest.fn().mockImplementation(async ({ data }) => {
          state.password = data.password;
        }),
      },
      session: {
        updateMany: jest.fn().mockImplementation(async () => {
          state.revoked = true;
          return { count: 2 };
        }),
      },
    };
    const resetToken = {
      id: 'reset-token-id',
      userId: 1,
      consumedAt: null,
      expiresAt: new Date(Date.now() + 60_000),
      user,
    };
    authTokenService.find.mockResolvedValue(resetToken);
    authTokenService.findInTransaction.mockResolvedValue(resetToken);
    sessionAuditService.recordSecurityEvent.mockImplementation(async (type) => {
      if (type === 'PASSWORD_RESET_COMPLETED') {
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
      service.resetPassword(
        { token: 'raw-token', password: 'new-password' },
        request,
        response,
      ),
    ).rejects.toThrow('audit unavailable');

    expect(state).toEqual({
      consumed: false,
      password: 'old-hash',
      revoked: false,
    });
    expect(sessionService.completePasswordChange).not.toHaveBeenCalled();
  });

  it('returns INVALID without opening a transaction for an unknown token', async () => {
    authTokenService.find.mockResolvedValue(null);

    await expect(
      service.resetPassword(
        { token: 'unknown', password: 'new-password' },
        request,
        response,
      ),
    ).resolves.toEqual({ status: 'INVALID' });

    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(sessionAuditService.recordSecurityEvent).toHaveBeenCalledWith(
      'PASSWORD_RESET_INVALID',
      request,
    );
  });

  it('returns ALREADY_USED during the precheck for an already consumed token', async () => {
    authTokenService.find.mockResolvedValue({
      id: 'reset-token-id',
      userId: 1,
      consumedAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
      user,
    });

    await expect(
      service.resetPassword(
        { token: 'raw-token', password: 'new-password' },
        request,
        response,
      ),
    ).resolves.toEqual({ status: 'ALREADY_USED' });

    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(userService.hashPassword).not.toHaveBeenCalled();
    expect(sessionAuditService.recordSecurityEvent).toHaveBeenCalledWith(
      'PASSWORD_RESET_REUSED',
      request,
      1,
    );
    expect(sessionService.completePasswordChange).not.toHaveBeenCalled();
  });

  it('returns EXPIRED during the precheck for an expired token', async () => {
    authTokenService.find.mockResolvedValue({
      id: 'reset-token-id',
      userId: 1,
      consumedAt: null,
      expiresAt: new Date(Date.now() - 1),
      user,
    });

    await expect(
      service.resetPassword(
        { token: 'raw-token', password: 'new-password' },
        request,
        response,
      ),
    ).resolves.toEqual({ status: 'EXPIRED' });

    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(userService.hashPassword).not.toHaveBeenCalled();
    expect(sessionAuditService.recordSecurityEvent).toHaveBeenCalledWith(
      'PASSWORD_RESET_EXPIRED',
      request,
      1,
    );
    expect(sessionService.completePasswordChange).not.toHaveBeenCalled();
  });

  it('returns ALREADY_USED when the token is consumed between precheck and transaction', async () => {
    const transaction = {
      authToken: { updateMany: jest.fn() },
      user: { update: jest.fn() },
      session: { updateMany: jest.fn() },
    };
    const activeToken = {
      id: 'reset-token-id',
      userId: 1,
      consumedAt: null,
      expiresAt: new Date(Date.now() + 60_000),
      user,
    };
    authTokenService.find.mockResolvedValue(activeToken);
    authTokenService.findInTransaction.mockResolvedValue({
      ...activeToken,
      consumedAt: new Date(),
    });
    prisma.$transaction.mockImplementation((callback) => callback(transaction));

    await expect(
      service.resetPassword(
        { token: 'raw-token', password: 'new-password' },
        request,
        response,
      ),
    ).resolves.toEqual({ status: 'ALREADY_USED' });

    expect(transaction.authToken.updateMany).not.toHaveBeenCalled();
    expect(transaction.user.update).not.toHaveBeenCalled();
    expect(transaction.session.updateMany).not.toHaveBeenCalled();
    expect(sessionAuditService.recordSecurityEvent).toHaveBeenCalledWith(
      'PASSWORD_RESET_REUSED',
      request,
      1,
      undefined,
      transaction,
    );
    expect(sessionService.completePasswordChange).not.toHaveBeenCalled();
  });

  it('returns EXPIRED when the token expires between precheck and transaction', async () => {
    const transaction = {
      authToken: { updateMany: jest.fn() },
      user: { update: jest.fn() },
      session: { updateMany: jest.fn() },
    };
    const activeToken = {
      id: 'reset-token-id',
      userId: 1,
      consumedAt: null,
      expiresAt: new Date(Date.now() + 60_000),
      user,
    };
    authTokenService.find.mockResolvedValue(activeToken);
    authTokenService.findInTransaction.mockResolvedValue({
      ...activeToken,
      expiresAt: new Date(Date.now() - 1),
    });
    prisma.$transaction.mockImplementation((callback) => callback(transaction));

    await expect(
      service.resetPassword(
        { token: 'raw-token', password: 'new-password' },
        request,
        response,
      ),
    ).resolves.toEqual({ status: 'EXPIRED' });

    expect(transaction.authToken.updateMany).not.toHaveBeenCalled();
    expect(transaction.user.update).not.toHaveBeenCalled();
    expect(transaction.session.updateMany).not.toHaveBeenCalled();
    expect(sessionAuditService.recordSecurityEvent).toHaveBeenCalledWith(
      'PASSWORD_RESET_EXPIRED',
      request,
      1,
      undefined,
      transaction,
    );
    expect(sessionService.completePasswordChange).not.toHaveBeenCalled();
  });
});
