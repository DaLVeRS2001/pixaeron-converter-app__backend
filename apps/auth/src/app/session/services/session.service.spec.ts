import { Logger, UnauthorizedException } from '@nestjs/common';
import { compare } from 'bcryptjs';
import type { Request, Response } from 'express';

import { SessionRevokedReason } from '../../../generated/prisma/client';
import { authenticatedUserSelect } from '../../user/prisma/user.select';
import {
  ACCESS_TOKEN_COOKIE,
  REFRESH_TOKEN_COOKIE,
} from '../constants/session.constants';
import { SessionService } from './session.service';

jest.mock('bcryptjs', () => ({ compare: jest.fn() }));

const user = {
  id: 1,
  publicId: '0198f687-15d8-7f5e-bd79-62f8f4d51e07',
  email: 'user@example.com',
  username: 'User',
  emailVerified: true,
  planCode: 'FREE',
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-01T00:00:00.000Z'),
};

const activeSession = {
  id: 'session-id',
  userId: user.id,
  refreshTokenHash: 'current-hash',
  expiresAt: new Date('2099-01-01T00:00:00.000Z'),
  revokedAt: null,
  rememberMe: true,
  userAgent: 'old-agent',
  ipHash: 'old-ip',
  user,
};

describe('SessionService', () => {
  const prisma = {
    $transaction: jest.fn(),
    session: {
      create: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
    user: { findUnique: jest.fn() },
  };
  const tokens = {
    parseRefreshToken: jest.fn(),
    verifyAccessToken: jest.fn(),
    generateRefreshSecret: jest.fn(),
    hashRefreshSecret: jest.fn(),
    signAccessToken: jest.fn(),
    getRefreshExpiresAt: jest.fn(),
  };
  const cookies = {
    setAuthCookies: jest.fn(),
    clearAuthCookies: jest.fn(),
  };
  const metadata = {
    getFromRequest: jest.fn(),
  };
  const audit = {
    recordSessionStarted: jest.fn(),
    recordRefreshFailed: jest.fn(),
    recordSessionExpired: jest.fn(),
    recordRefreshMetadataChanges: jest.fn(),
    recordRefreshSuccess: jest.fn(),
  };
  const request = {
    cookies: { [REFRESH_TOKEN_COOKIE]: 'session-id.current-secret' },
  } as unknown as Request;
  const response = {} as Response;
  const service = new SessionService(
    prisma as never,
    tokens as never,
    cookies as never,
    metadata as never,
    audit as never,
  );

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.$transaction.mockImplementation(
      (callback: (transaction: typeof prisma) => unknown) => callback(prisma),
    );
    tokens.parseRefreshToken.mockReturnValue({
      sessionId: activeSession.id,
      refreshSecret: 'current-secret',
    });
    tokens.generateRefreshSecret.mockReturnValue('next-secret');
    tokens.hashRefreshSecret.mockResolvedValue('next-hash');
    tokens.signAccessToken.mockReturnValue('next-access-token');
    tokens.getRefreshExpiresAt.mockReturnValue(activeSession.expiresAt);
    metadata.getFromRequest.mockReturnValue({
      userAgent: 'new-agent',
      ipHash: 'new-ip',
    });
    audit.recordRefreshMetadataChanges.mockResolvedValue(undefined);
    audit.recordRefreshSuccess.mockResolvedValue(undefined);
    audit.recordRefreshFailed.mockResolvedValue(undefined);
    audit.recordSessionStarted.mockResolvedValue(undefined);
  });

  it('signs a new session access token with the public user subject', async () => {
    prisma.user.findUnique.mockResolvedValue(user);
    prisma.session.create.mockResolvedValue(activeSession);

    await expect(
      service.createSession(user.id, request, response, 'LOGIN_SUCCESS', true),
    ).resolves.toBe(user);

    expect(tokens.signAccessToken).toHaveBeenCalledWith(user.publicId);
    expect(cookies.setAuthCookies).toHaveBeenCalledWith(
      response,
      'next-access-token',
      'session-id.next-secret',
      true,
    );
  });
  it('authenticates a valid access token without rotating the refresh token', async () => {
    const accessRequest = {
      cookies: { [ACCESS_TOKEN_COOKIE]: 'access-token' },
    } as unknown as Request;
    tokens.verifyAccessToken.mockResolvedValue({ subject: user.publicId });
    prisma.user.findUnique.mockResolvedValue(user);

    await expect(service.authenticateAccessToken(accessRequest)).resolves.toBe(
      user,
    );

    expect(prisma.user.findUnique).toHaveBeenCalledWith({
      where: { publicId: user.publicId },
      select: authenticatedUserSelect,
    });
    expect(prisma.session.findUnique).not.toHaveBeenCalled();
    expect(cookies.setAuthCookies).not.toHaveBeenCalled();
  });

  it('never falls back to the refresh cookie for access authentication', async () => {
    tokens.verifyAccessToken.mockResolvedValue(null);

    await expect(service.authenticateAccessToken(request)).rejects.toThrow(
      UnauthorizedException,
    );

    expect(tokens.parseRefreshToken).not.toHaveBeenCalled();
    expect(prisma.session.findUnique).not.toHaveBeenCalled();
    expect(cookies.clearAuthCookies).not.toHaveBeenCalled();
  });

  it('keeps implicit refresh during the staged frontend rollout', async () => {
    tokens.verifyAccessToken.mockResolvedValue(null);
    prisma.session.findUnique.mockResolvedValue(activeSession);
    (compare as jest.Mock).mockResolvedValue(true);
    prisma.session.updateMany.mockResolvedValue({ count: 1 });

    await expect(service.authenticateRequest(request, response)).resolves.toBe(
      user,
    );

    expect(tokens.parseRefreshToken).toHaveBeenCalledWith(
      'session-id.current-secret',
    );
    expect(cookies.setAuthCookies).toHaveBeenCalledTimes(1);
  });

  it('rotates an active refresh token with a compare-and-swap update', async () => {
    prisma.session.findUnique.mockResolvedValue(activeSession);
    (compare as jest.Mock).mockResolvedValue(true);
    prisma.session.updateMany.mockResolvedValue({ count: 1 });

    await expect(service.refreshSession(request, response)).resolves.toBe(user);

    expect(prisma.session.updateMany).toHaveBeenCalledWith({
      where: {
        id: activeSession.id,
        refreshTokenHash: activeSession.refreshTokenHash,
        revokedAt: null,
        expiresAt: { gt: expect.any(Date) },
      },
      data: {
        refreshTokenHash: 'next-hash',
        lastUsedAt: expect.any(Date),
        rotatedAt: expect.any(Date),
        userAgent: 'new-agent',
        ipHash: 'new-ip',
      },
    });
    expect(tokens.signAccessToken).toHaveBeenCalledWith(user.publicId);
    expect(cookies.setAuthCookies).toHaveBeenCalledWith(
      response,
      'next-access-token',
      'session-id.next-secret',
      true,
    );
    expect(cookies.clearAuthCookies).not.toHaveBeenCalled();
  });

  it('does not clear winner cookies when it loses a concurrent rotation', async () => {
    prisma.session.findUnique.mockResolvedValue(activeSession);
    (compare as jest.Mock).mockResolvedValue(true);
    prisma.session.updateMany.mockResolvedValue({ count: 0 });

    await expect(service.refreshSession(request, response)).rejects.toThrow(
      UnauthorizedException,
    );

    expect(audit.recordRefreshFailed).toHaveBeenCalledWith(
      activeSession.id,
      activeSession.userId,
      request,
      'concurrent_refresh_rotation',
    );
    expect(prisma.session.updateMany).toHaveBeenCalledTimes(1);
    expect(prisma.session.update).not.toHaveBeenCalled();
    expect(cookies.setAuthCookies).not.toHaveBeenCalled();
    expect(cookies.clearAuthCookies).not.toHaveBeenCalled();
  });

  it('does not revoke a session for an unproven refresh secret', async () => {
    prisma.session.findUnique.mockResolvedValue(activeSession);
    (compare as jest.Mock).mockResolvedValue(false);

    await expect(service.refreshSession(request, response)).rejects.toThrow(
      UnauthorizedException,
    );

    expect(audit.recordRefreshFailed).toHaveBeenCalledWith(
      activeSession.id,
      activeSession.userId,
      request,
      'invalid_refresh_secret',
    );
    expect(prisma.session.update).not.toHaveBeenCalled();
    expect(prisma.session.updateMany).not.toHaveBeenCalled();
    expect(cookies.setAuthCookies).not.toHaveBeenCalled();
    expect(cookies.clearAuthCookies).not.toHaveBeenCalled();
  });

  it('keeps a successful rotation when best-effort audit fails', async () => {
    prisma.session.findUnique.mockResolvedValue(activeSession);
    (compare as jest.Mock).mockResolvedValue(true);
    prisma.session.updateMany.mockResolvedValue({ count: 1 });
    audit.recordRefreshMetadataChanges.mockRejectedValue(
      new Error('audit unavailable'),
    );
    const logger = jest.spyOn(Logger.prototype, 'error').mockImplementation();

    await expect(service.refreshSession(request, response)).resolves.toBe(user);

    expect(cookies.setAuthCookies).toHaveBeenCalledTimes(1);
    expect(cookies.clearAuthCookies).not.toHaveBeenCalled();
    expect(cookies.setAuthCookies.mock.invocationCallOrder[0]).toBeLessThan(
      audit.recordRefreshMetadataChanges.mock.invocationCallOrder[0],
    );
    expect(logger).toHaveBeenCalledWith(
      'Failed to record successful session refresh audit',
    );
    logger.mockRestore();
  });

  it('revokes an expired session and clears its cookies', async () => {
    const expiredSession = {
      ...activeSession,
      expiresAt: new Date('2000-01-01T00:00:00.000Z'),
    };
    prisma.session.findUnique.mockResolvedValue(expiredSession);
    prisma.session.update.mockResolvedValue(expiredSession);
    audit.recordSessionExpired.mockResolvedValue(undefined);

    await expect(service.refreshSession(request, response)).rejects.toThrow(
      UnauthorizedException,
    );

    expect(prisma.session.update).toHaveBeenCalledWith({
      where: { id: expiredSession.id },
      data: {
        revokedAt: expect.any(Date),
        revokedReason: SessionRevokedReason.EXPIRED,
      },
    });
    expect(cookies.clearAuthCookies).toHaveBeenCalledWith(response);
  });
});
