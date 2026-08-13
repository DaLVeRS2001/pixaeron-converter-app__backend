import { UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import type { Request, Response } from 'express';
import { generateKeyPairSync, randomUUID } from 'node:crypto';

import {
  SessionEventType,
  SessionRevokedReason,
} from '../../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { SessionAuditService } from '../audit/session-audit.service';
import {
  REFRESH_REUSE_GRACE_MS,
  REFRESH_TOKEN_COOKIE,
} from '../constants/session.constants';
import { AccessTokenKeyService } from './access-token-key.service';
import { SessionCookieService } from './session-cookie.service';
import { SessionMetadataService } from './session-metadata.service';
import { SessionService } from './session.service';
import { SessionTokenService } from './session-token.service';

const createResponse = () => {
  const cookies: Record<string, string> = {};

  return {
    cookies,
    response: {
      cookie: (name: string, value: string) => {
        cookies[name] = value;
      },
      clearCookie: (name: string) => {
        delete cookies[name];
      },
    } as unknown as Response,
  };
};

const createRequest = (refreshToken?: string): Request =>
  ({
    cookies: refreshToken ? { [REFRESH_TOKEN_COOKIE]: refreshToken } : {},
    headers: { 'user-agent': 'session-rotation-integration' },
    ip: '203.0.113.7',
    socket: { remoteAddress: '203.0.113.7' },
  }) as unknown as Request;

describe('SessionService refresh rotation on Postgres', () => {
  let prisma: PrismaService;
  let service: SessionService;
  let userIds: number[] = [];

  beforeAll(() => {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const configService = new ConfigService({
      DATABASE_URL: process.env['DATABASE_URL'],
      IP_HASH_SECRET: 'session-rotation-integration-ip-hash-secret',
      JWT_AUDIENCE: 'pixaeron-web',
      JWT_EXPIRATION_MS: '900000',
      JWT_ISSUER: 'https://api.pixaeron.com/auth',
      JWT_PRIVATE_KEY_BASE64: privateKey
        .export({ format: 'der', type: 'pkcs8' })
        .toString('base64'),
      REFRESH_EXPIRATION_MS: '2592000000',
      REFRESH_TOKEN_HASH_ROUNDS: '4',
      SESSION_REFRESH_EXPIRATION_MS: '3600000',
    });

    prisma = new PrismaService(configService);
    const metadataService = new SessionMetadataService(configService);
    const tokenService = new SessionTokenService(
      configService,
      new JwtService({}),
      new AccessTokenKeyService(configService),
    );
    service = new SessionService(
      prisma,
      tokenService,
      new SessionCookieService(configService),
      metadataService,
      new SessionAuditService(prisma, metadataService),
    );
  });

  afterEach(async () => {
    await prisma.sessionEvent.deleteMany({
      where: { userId: { in: userIds } },
    });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    userIds = [];
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  const startSession = async () => {
    const user = await prisma.user.create({
      data: {
        email: `rotation-${randomUUID()}@example.com`,
        username: 'rotation-integration',
      },
    });
    userIds.push(user.id);

    const { cookies, response } = createResponse();
    await service.createSession(
      user.id,
      createRequest(),
      response,
      'LOGIN_SUCCESS',
    );

    return { refreshToken: cookies[REFRESH_TOKEN_COOKIE], user };
  };

  const refresh = (refreshToken: string) => {
    const recorder = createResponse();

    return {
      cookies: recorder.cookies,
      outcome: service.refreshSession(
        createRequest(refreshToken),
        recorder.response,
      ),
    };
  };

  it('rotates exactly once when the same token is refreshed in parallel', async () => {
    const { refreshToken, user } = await startSession();

    const attempts = Array.from({ length: 6 }, () => refresh(refreshToken));
    const outcomes = await Promise.allSettled(
      attempts.map(({ outcome }) => outcome),
    );

    const fulfilled = outcomes.filter(
      (outcome) => outcome.status === 'fulfilled',
    );
    expect(fulfilled).toHaveLength(1);
    for (const outcome of outcomes) {
      if (outcome.status === 'rejected') {
        expect(outcome.reason).toBeInstanceOf(UnauthorizedException);
      }
    }

    const session = await prisma.session.findFirstOrThrow({
      where: { userId: user.id },
    });
    expect(session.revokedAt).toBeNull();

    const refreshTokens = await prisma.sessionRefreshToken.findMany({
      where: { sessionId: session.id },
    });
    expect(refreshTokens).toHaveLength(2);
    expect(
      refreshTokens.filter(({ consumedAt }) => consumedAt === null),
    ).toHaveLength(1);

    const winner = attempts.find(
      (_, index) => outcomes[index].status === 'fulfilled',
    );
    await expect(
      refresh(winner!.cookies[REFRESH_TOKEN_COOKIE]).outcome,
    ).resolves.toMatchObject({ id: user.id });
  });

  it('keeps the session alive when the previous token is replayed within the grace window', async () => {
    const { refreshToken, user } = await startSession();
    const first = refresh(refreshToken);
    await first.outcome;

    await expect(refresh(refreshToken).outcome).rejects.toBeInstanceOf(
      UnauthorizedException,
    );

    const session = await prisma.session.findFirstOrThrow({
      where: { userId: user.id },
    });
    expect(session.revokedAt).toBeNull();

    await expect(
      refresh(first.cookies[REFRESH_TOKEN_COOKIE]).outcome,
    ).resolves.toMatchObject({ id: user.id });
  });

  it('revokes the session when an older consumed token is replayed while still fresh', async () => {
    const { refreshToken, user } = await startSession();
    const first = refresh(refreshToken);
    await first.outcome;
    const second = refresh(first.cookies[REFRESH_TOKEN_COOKIE]);
    await second.outcome;

    await expect(refresh(refreshToken).outcome).rejects.toBeInstanceOf(
      UnauthorizedException,
    );

    const session = await prisma.session.findFirstOrThrow({
      where: { userId: user.id },
    });
    expect(session.revokedAt).not.toBeNull();
    expect(session.revokedReason).toBe(SessionRevokedReason.REFRESH_REUSE);

    await expect(
      refresh(second.cookies[REFRESH_TOKEN_COOKIE]).outcome,
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('revokes the whole session when a consumed token is replayed after the grace window', async () => {
    const { refreshToken, user } = await startSession();
    const first = refresh(refreshToken);
    await first.outcome;

    const session = await prisma.session.findFirstOrThrow({
      where: { userId: user.id },
    });
    const staleRotatedAt = new Date(
      Date.now() - REFRESH_REUSE_GRACE_MS - 5_000,
    );
    await prisma.session.update({
      where: { id: session.id },
      data: { rotatedAt: staleRotatedAt },
    });
    await prisma.sessionRefreshToken.updateMany({
      where: { sessionId: session.id, consumedAt: { not: null } },
      data: { consumedAt: staleRotatedAt },
    });

    await expect(refresh(refreshToken).outcome).rejects.toBeInstanceOf(
      UnauthorizedException,
    );

    const revoked = await prisma.session.findUniqueOrThrow({
      where: { id: session.id },
    });
    expect(revoked.revokedAt).not.toBeNull();
    expect(revoked.revokedReason).toBe(SessionRevokedReason.REFRESH_REUSE);

    await expect(
      refresh(first.cookies[REFRESH_TOKEN_COOKIE]).outcome,
    ).rejects.toBeInstanceOf(UnauthorizedException);

    const reuseEvents = await prisma.sessionEvent.findMany({
      where: {
        sessionId: session.id,
        type: SessionEventType.REFRESH_REUSE_DETECTED,
      },
    });
    expect(reuseEvents).toHaveLength(1);
    const finalState = await prisma.session.findUniqueOrThrow({
      where: { id: session.id },
    });
    expect(finalState.revokedAt).toEqual(revoked.revokedAt);
    expect(finalState.revokedReason).toBe(SessionRevokedReason.REFRESH_REUSE);
  });
});
