import { Logger, UnauthorizedException } from '@nestjs/common';
import type { Request, Response } from 'express';

import { SessionRevokedReason } from '../../../generated/prisma/client';
import { authenticatedUserSelect } from '../../user/prisma/user.select';
import {
  ACCESS_TOKEN_COOKIE,
  REFRESH_REUSE_GRACE_MS,
  REFRESH_TOKEN_COOKIE,
} from '../constants/session.constants';
import { SessionService } from './session.service';

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

const activeRefreshToken = {
  id: 'refresh-token-id',
  sessionId: 'session-id',
  credentialHash: 'current-hash',
  consumedAt: null,
};

const nextRefreshCredential = {
  credential: 'next-token-id.next-secret',
  hash: 'next-hash',
  tokenId: 'next-token-id',
};

const activeSession = {
  id: 'session-id',
  userId: user.id,
  refreshTokenHash: 'current-hash',
  rotatedAt: new Date('2026-01-01T00:00:00.000Z'),
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
    sessionRefreshToken: {
      create: jest.fn(),
      findUnique: jest.fn(),
      updateMany: jest.fn(),
      upsert: jest.fn(),
    },
    user: { findUnique: jest.fn() },
  };
  const tokens = {
    parseRefreshToken: jest.fn(),
    verifyAccessToken: jest.fn(),
    issueRefreshCredential: jest.fn(),
    verifyRefreshCredential: jest.fn(),
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
    recordRefreshReuseDetected: jest.fn(),
    recordRefreshSuccess: jest.fn(),
  };
  const request = {
    cookies: {
      [REFRESH_TOKEN_COOKIE]: 'session-id.refresh-token-id.current-secret',
    },
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
    prisma.session.updateMany.mockResolvedValue({ count: 1 });
    prisma.sessionRefreshToken.findUnique.mockResolvedValue(activeRefreshToken);
    prisma.sessionRefreshToken.updateMany.mockResolvedValue({ count: 1 });
    tokens.parseRefreshToken.mockReturnValue({
      sessionId: activeSession.id,
      tokenId: activeRefreshToken.id,
      refreshCredential: `${activeRefreshToken.id}.current-secret`,
    });
    tokens.issueRefreshCredential.mockResolvedValue(nextRefreshCredential);
    tokens.verifyRefreshCredential.mockResolvedValue(true);
    tokens.signAccessToken.mockReturnValue('next-access-token');
    tokens.getRefreshExpiresAt.mockReturnValue(activeSession.expiresAt);
    metadata.getFromRequest.mockReturnValue({
      userAgent: 'new-agent',
      ipHash: 'new-ip',
    });
    audit.recordRefreshMetadataChanges.mockResolvedValue(undefined);
    audit.recordRefreshReuseDetected.mockResolvedValue(undefined);
    audit.recordRefreshSuccess.mockResolvedValue(undefined);
    audit.recordRefreshFailed.mockResolvedValue(undefined);
    audit.recordSessionStarted.mockResolvedValue(undefined);
  });

  it('creates a tracked refresh token for a new session', async () => {
    prisma.user.findUnique.mockResolvedValue(user);
    prisma.session.create.mockResolvedValue(activeSession);

    await expect(
      service.createSession(user.id, request, response, 'LOGIN_SUCCESS', true),
    ).resolves.toBe(user);

    expect(prisma.session.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: user.id,
        refreshTokenHash: nextRefreshCredential.hash,
        refreshTokens: {
          create: {
            id: nextRefreshCredential.tokenId,
            credentialHash: nextRefreshCredential.hash,
          },
        },
      }),
    });
    expect(tokens.signAccessToken).toHaveBeenCalledWith(user.publicId);
    expect(cookies.setAuthCookies).toHaveBeenCalledWith(
      response,
      'next-access-token',
      `session-id.${nextRefreshCredential.credential}`,
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

    await expect(service.authenticateRequest(request, response)).resolves.toBe(
      user,
    );

    expect(tokens.parseRefreshToken).toHaveBeenCalledWith(
      'session-id.refresh-token-id.current-secret',
    );
    expect(cookies.setAuthCookies).toHaveBeenCalledTimes(1);
  });

  it('rotates a tracked refresh token atomically', async () => {
    prisma.session.findUnique.mockResolvedValue(activeSession);

    await expect(service.refreshSession(request, response)).resolves.toBe(user);

    const nextCredential = nextRefreshCredential.credential;
    expect(prisma.session.updateMany).toHaveBeenCalledWith({
      where: {
        id: activeSession.id,
        refreshTokenHash: activeRefreshToken.credentialHash,
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
    expect(prisma.sessionRefreshToken.updateMany).toHaveBeenCalledWith({
      where: {
        id: activeRefreshToken.id,
        sessionId: activeSession.id,
        credentialHash: activeRefreshToken.credentialHash,
        consumedAt: null,
      },
      data: { consumedAt: expect.any(Date) },
    });
    expect(prisma.sessionRefreshToken.create).toHaveBeenCalledWith({
      data: {
        id: nextRefreshCredential.tokenId,
        sessionId: activeSession.id,
        credentialHash: 'next-hash',
      },
    });
    expect(tokens.signAccessToken).toHaveBeenCalledWith(user.publicId);
    expect(cookies.setAuthCookies).toHaveBeenCalledWith(
      response,
      'next-access-token',
      `session-id.${nextCredential}`,
      true,
    );
    expect(cookies.clearAuthCookies).not.toHaveBeenCalled();
  });

  it('upgrades a legacy refresh cookie during rotation', async () => {
    tokens.parseRefreshToken.mockReturnValue({
      sessionId: activeSession.id,
      refreshCredential: 'legacy-secret',
    });
    prisma.session.findUnique.mockResolvedValue(activeSession);

    await expect(service.refreshSession(request, response)).resolves.toBe(user);

    const nextCredential = nextRefreshCredential.credential;
    expect(prisma.sessionRefreshToken.findUnique).not.toHaveBeenCalled();
    expect(prisma.sessionRefreshToken.updateMany).toHaveBeenCalledWith({
      where: { sessionId: activeSession.id, consumedAt: null },
      data: { consumedAt: expect.any(Date) },
    });
    expect(prisma.sessionRefreshToken.upsert).toHaveBeenCalledWith({
      where: { id: activeSession.id },
      create: {
        id: activeSession.id,
        sessionId: activeSession.id,
        credentialHash: activeSession.refreshTokenHash,
        consumedAt: expect.any(Date),
      },
      update: {
        credentialHash: activeSession.refreshTokenHash,
        consumedAt: expect.any(Date),
      },
    });
    expect(cookies.setAuthCookies).toHaveBeenCalledWith(
      response,
      'next-access-token',
      `session-id.${nextCredential}`,
      true,
    );
  });

  it('does not clear winner cookies when session rotation loses CAS', async () => {
    prisma.session.findUnique.mockResolvedValue(activeSession);
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
    expect(prisma.sessionRefreshToken.updateMany).not.toHaveBeenCalled();
    expect(cookies.setAuthCookies).not.toHaveBeenCalled();
    expect(cookies.clearAuthCookies).not.toHaveBeenCalled();
  });

  it('does not issue tokens when refresh-token consumption loses CAS', async () => {
    prisma.session.findUnique.mockResolvedValue(activeSession);
    prisma.sessionRefreshToken.updateMany.mockResolvedValue({ count: 0 });

    await expect(service.refreshSession(request, response)).rejects.toThrow(
      UnauthorizedException,
    );

    expect(audit.recordRefreshFailed).toHaveBeenCalledWith(
      activeSession.id,
      activeSession.userId,
      request,
      'concurrent_refresh_rotation',
    );
    expect(prisma.sessionRefreshToken.create).not.toHaveBeenCalled();
    expect(cookies.setAuthCookies).not.toHaveBeenCalled();
    expect(cookies.clearAuthCookies).not.toHaveBeenCalled();
  });

  it('allows a short grace window only for the immediate previous token', async () => {
    const consumedAt = new Date(Date.now() - 1_000);
    prisma.session.findUnique.mockResolvedValue({
      ...activeSession,
      rotatedAt: consumedAt,
    });
    prisma.sessionRefreshToken.findUnique.mockResolvedValue({
      ...activeRefreshToken,
      consumedAt,
    });

    await expect(service.refreshSession(request, response)).rejects.toThrow(
      UnauthorizedException,
    );

    expect(audit.recordRefreshFailed).toHaveBeenCalledWith(
      activeSession.id,
      activeSession.userId,
      request,
      'concurrent_refresh_rotation',
    );
    expect(prisma.session.updateMany).not.toHaveBeenCalled();
    expect(audit.recordRefreshReuseDetected).not.toHaveBeenCalled();
    expect(cookies.clearAuthCookies).not.toHaveBeenCalled();
  });

  it.each([
    [
      'an immediate previous token after grace',
      -REFRESH_REUSE_GRACE_MS - 1_000,
      true,
    ],
    ['an older family token inside grace', -1_000, false],
  ])(
    'revokes the token family for %s',
    async (_case, consumedOffset, isPrevious) => {
      const now = Date.now();
      const consumedAt = new Date(now + consumedOffset);
      const rotatedAt = isPrevious ? consumedAt : new Date(now - 500);
      prisma.session.findUnique.mockResolvedValue({
        ...activeSession,
        rotatedAt,
      });
      prisma.sessionRefreshToken.findUnique.mockResolvedValue({
        ...activeRefreshToken,
        consumedAt,
      });
      audit.recordRefreshReuseDetected.mockRejectedValue(
        new Error('audit unavailable'),
      );
      const logger = jest.spyOn(Logger.prototype, 'error').mockImplementation();

      try {
        await expect(service.refreshSession(request, response)).rejects.toThrow(
          UnauthorizedException,
        );

        expect(prisma.session.updateMany).toHaveBeenCalledWith({
          where: { id: activeSession.id, revokedAt: null },
          data: {
            revokedAt: expect.any(Date),
            revokedReason: SessionRevokedReason.REFRESH_REUSE,
          },
        });
        expect(audit.recordRefreshReuseDetected).toHaveBeenCalledWith(
          activeSession.id,
          activeSession.userId,
          request,
        );
        expect(logger).toHaveBeenCalledWith(
          'Failed to record refresh-token reuse audit',
        );
        expect(cookies.setAuthCookies).not.toHaveBeenCalled();
        expect(cookies.clearAuthCookies).toHaveBeenCalledWith(response);
      } finally {
        logger.mockRestore();
      }
    },
  );

  it('does not revoke a session for an unproven refresh secret', async () => {
    prisma.session.findUnique.mockResolvedValue(activeSession);
    tokens.verifyRefreshCredential.mockResolvedValue(false);

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
    expect(prisma.sessionRefreshToken.updateMany).not.toHaveBeenCalled();
    expect(cookies.setAuthCookies).not.toHaveBeenCalled();
    expect(cookies.clearAuthCookies).not.toHaveBeenCalled();
  });

  it('keeps a successful rotation when best-effort audit fails', async () => {
    prisma.session.findUnique.mockResolvedValue(activeSession);
    audit.recordRefreshMetadataChanges.mockRejectedValue(
      new Error('audit unavailable'),
    );
    const logger = jest.spyOn(Logger.prototype, 'error').mockImplementation();

    try {
      await expect(service.refreshSession(request, response)).resolves.toBe(
        user,
      );

      expect(cookies.setAuthCookies).toHaveBeenCalledTimes(1);
      expect(cookies.clearAuthCookies).not.toHaveBeenCalled();
      expect(cookies.setAuthCookies.mock.invocationCallOrder[0]).toBeLessThan(
        audit.recordRefreshMetadataChanges.mock.invocationCallOrder[0],
      );
      expect(logger).toHaveBeenCalledWith(
        'Failed to record successful session refresh audit',
      );
    } finally {
      logger.mockRestore();
    }
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
