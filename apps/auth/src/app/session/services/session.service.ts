import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import type { Request, Response } from 'express';

import {
  SessionRevokedReason,
  type Session,
  type SessionRefreshToken,
} from '../../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import {
  AuthenticatedUser,
  authenticatedUserSelect,
} from '../../user/prisma/user.select';
import { SessionAuditService } from '../audit/session-audit.service';
import {
  ACCESS_TOKEN_COOKIE,
  REFRESH_REUSE_GRACE_MS,
  REFRESH_TOKEN_COOKIE,
} from '../constants/session.constants';
import { SessionCookieService } from './session-cookie.service';
import {
  SessionMetadataService,
  type SessionRequestMetadata,
} from './session-metadata.service';
import {
  type IssuedRefreshCredential,
  type ParsedRefreshToken,
  SessionTokenService,
} from './session-token.service';

type SessionStartedEventType = 'LOGIN_SUCCESS' | 'REGISTER_SUCCESS';

export class SessionCredentialChangedError extends Error {}

class SessionRotationConflictError extends Error {}

type RefreshSession = Session & { user: AuthenticatedUser };

type RefreshContext = {
  credentialHash: string;
  parsedToken: ParsedRefreshToken;
  refreshToken: SessionRefreshToken | null;
  session: RefreshSession;
};

@Injectable()
export class SessionService {
  private readonly logger = new Logger(SessionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly sessionTokenService: SessionTokenService,
    private readonly sessionCookieService: SessionCookieService,
    private readonly sessionMetadataService: SessionMetadataService,
    private readonly sessionAuditService: SessionAuditService,
  ) {}

  async createSession(
    userId: number,
    request: Request,
    response: Response,
    eventType: SessionStartedEventType,
    rememberMe = false,
    expectedPasswordHash?: string,
  ): Promise<AuthenticatedUser> {
    const now = new Date();
    const refreshCredential =
      await this.sessionTokenService.issueRefreshCredential();
    const requestMetadata = this.sessionMetadataService.getFromRequest(request);

    const { session, user } = await this.prisma.$transaction(
      async (transaction) => {
        if (expectedPasswordHash !== undefined) {
          const credentials = await transaction.$queryRaw<
            Array<{ password: string | null }>
          >`
            SELECT "password"
            FROM "User"
            WHERE "id" = ${userId}
            FOR UPDATE
          `;

          if (credentials[0]?.password !== expectedPasswordHash) {
            throw new SessionCredentialChangedError();
          }
        }

        const user = await transaction.user.findUnique({
          where: { id: userId },
          select: authenticatedUserSelect,
        });
        if (!user) throw new UnauthorizedException();

        const session = await transaction.session.create({
          data: {
            userId,
            refreshTokenHash: refreshCredential.hash,
            refreshTokens: {
              create: {
                id: refreshCredential.tokenId,
                credentialHash: refreshCredential.hash,
              },
            },
            expiresAt: this.sessionTokenService.getRefreshExpiresAt(
              now,
              rememberMe,
            ),
            lastUsedAt: now,
            rotatedAt: now,
            rememberMe,
            userAgent: requestMetadata.userAgent,
            ipHash: requestMetadata.ipHash,
          },
        });
        await this.sessionAuditService.recordSessionStarted(
          eventType,
          session.id,
          userId,
          request,
          transaction,
        );

        return { session, user };
      },
    );

    this.sessionCookieService.setAuthCookies(
      response,
      this.sessionTokenService.signAccessToken(user.publicId),
      `${session.id}.${refreshCredential.credential}`,
      rememberMe,
    );

    return user;
  }

  async authenticateRequest(
    request: Request,
    response: Response,
  ): Promise<AuthenticatedUser> {
    const user = await this.validateAccessToken(request);
    return user ?? this.refreshSession(request, response);
  }

  async authenticateAccessToken(request: Request): Promise<AuthenticatedUser> {
    const user = await this.validateAccessToken(request);
    if (!user) throw new UnauthorizedException();

    return user;
  }

  async refreshSession(
    request: Request,
    response: Response,
  ): Promise<AuthenticatedUser> {
    const now = new Date();
    const context = await this.loadAndValidateRefreshContext(
      request,
      response,
      now,
    );
    await this.handleConsumedRefreshToken(context, request, response, now);

    const nextCredential =
      await this.sessionTokenService.issueRefreshCredential();
    const requestMetadata = this.sessionMetadataService.getFromRequest(request);

    try {
      await this.rotateRefreshCredentialAtomically(
        context,
        nextCredential,
        requestMetadata,
        now,
      );
    } catch (error) {
      if (!(error instanceof SessionRotationConflictError)) throw error;

      await this.sessionAuditService.recordRefreshFailed(
        context.session.id,
        context.session.userId,
        request,
        'concurrent_refresh_rotation',
      );
      throw new UnauthorizedException();
    }

    this.sessionCookieService.setAuthCookies(
      response,
      this.sessionTokenService.signAccessToken(context.session.user.publicId),
      `${context.session.id}.${nextCredential.credential}`,
      context.session.rememberMe,
    );

    try {
      await this.sessionAuditService.recordRefreshMetadataChanges({
        sessionId: context.session.id,
        userId: context.session.userId,
        previousIpHash: context.session.ipHash,
        previousUserAgent: context.session.userAgent,
        currentMetadata: requestMetadata,
        request,
      });
      await this.sessionAuditService.recordRefreshSuccess(
        context.session.id,
        context.session.userId,
        request,
      );
    } catch {
      this.logger.error('Failed to record successful session refresh audit');
    }

    return context.session.user;
  }

  completePasswordChange(response: Response): void {
    this.sessionCookieService.clearAuthCookies(response);
  }

  async logout(request: Request, response: Response): Promise<boolean> {
    try {
      const parsedToken = this.sessionTokenService.parseRefreshToken(
        request.cookies?.[REFRESH_TOKEN_COOKIE],
      );

      if (!parsedToken) return true;

      const session = await this.prisma.session.findUnique({
        where: { id: parsedToken.sessionId },
      });
      const ownsSession =
        session &&
        !session.revokedAt &&
        (await this.sessionTokenService.verifyRefreshCredential(
          parsedToken.refreshCredential,
          session.refreshTokenHash,
        ));

      if (!ownsSession) return true;

      await this.prisma.session.update({
        where: { id: session.id },
        data: {
          revokedAt: new Date(),
          revokedReason: SessionRevokedReason.LOGOUT,
        },
      });
      await this.sessionAuditService.recordLogout(
        session.id,
        session.userId,
        request,
      );

      return true;
    } finally {
      this.sessionCookieService.clearAuthCookies(response);
    }
  }

  async logoutAll(
    userId: number,
    request: Request,
    response: Response,
  ): Promise<boolean> {
    try {
      const result = await this.prisma.session.updateMany({
        where: { userId, revokedAt: null },
        data: {
          revokedAt: new Date(),
          revokedReason: SessionRevokedReason.LOGOUT_ALL,
        },
      });
      await this.sessionAuditService.recordLogoutAll(
        userId,
        request,
        result.count,
      );

      return true;
    } finally {
      this.sessionCookieService.clearAuthCookies(response);
    }
  }

  private async loadAndValidateRefreshContext(
    request: Request,
    response: Response,
    now: Date,
  ): Promise<RefreshContext> {
    const parsedToken = this.sessionTokenService.parseRefreshToken(
      request.cookies?.[REFRESH_TOKEN_COOKIE],
    );
    if (!parsedToken) return this.rejectSession(response);

    const session = await this.prisma.session.findUnique({
      where: { id: parsedToken.sessionId },
      include: { user: { select: authenticatedUserSelect } },
    });
    if (!session) return this.rejectSession(response);

    await this.assertRefreshAllowed(session, request, response, now);

    const refreshToken = parsedToken.tokenId
      ? await this.prisma.sessionRefreshToken.findUnique({
          where: { id: parsedToken.tokenId },
        })
      : null;
    const credentialHash = parsedToken.tokenId
      ? refreshToken?.credentialHash
      : session.refreshTokenHash;

    if (
      !credentialHash ||
      (refreshToken && refreshToken.sessionId !== session.id) ||
      !(await this.sessionTokenService.verifyRefreshCredential(
        parsedToken.refreshCredential,
        credentialHash,
      ))
    ) {
      await this.sessionAuditService.recordRefreshFailed(
        session.id,
        session.userId,
        request,
        'invalid_refresh_secret',
      );
      throw new UnauthorizedException();
    }

    return { credentialHash, parsedToken, refreshToken, session };
  }

  private async assertRefreshAllowed(
    session: RefreshSession,
    request: Request,
    response: Response,
    now: Date,
  ): Promise<void> {
    if (session.revokedAt) {
      await this.sessionAuditService.recordRefreshFailed(
        session.id,
        session.userId,
        request,
        'session_revoked',
      );
      return this.rejectSession(response);
    }

    if (session.expiresAt <= now) {
      await this.prisma.session.update({
        where: { id: session.id },
        data: {
          revokedAt: now,
          revokedReason: SessionRevokedReason.EXPIRED,
        },
      });
      await this.sessionAuditService.recordSessionExpired(
        session.id,
        session.userId,
        request,
      );
      return this.rejectSession(response);
    }
  }

  private async handleConsumedRefreshToken(
    context: RefreshContext,
    request: Request,
    response: Response,
    now: Date,
  ): Promise<void> {
    const consumedAt = context.refreshToken?.consumedAt;
    if (!consumedAt) return;

    const reuseAge = now.getTime() - consumedAt.getTime();
    const isPreviousToken =
      context.session.rotatedAt?.getTime() === consumedAt.getTime();

    if (
      isPreviousToken &&
      reuseAge >= 0 &&
      reuseAge <= REFRESH_REUSE_GRACE_MS
    ) {
      await this.sessionAuditService.recordRefreshFailed(
        context.session.id,
        context.session.userId,
        request,
        'concurrent_refresh_rotation',
      );
      throw new UnauthorizedException();
    }

    const revoked = await this.prisma.session.updateMany({
      where: { id: context.session.id, revokedAt: null },
      data: {
        revokedAt: now,
        revokedReason: SessionRevokedReason.REFRESH_REUSE,
      },
    });

    if (revoked.count === 1) {
      try {
        await this.sessionAuditService.recordRefreshReuseDetected(
          context.session.id,
          context.session.userId,
          request,
        );
      } catch {
        this.logger.error('Failed to record refresh-token reuse audit');
      }
    }

    return this.rejectSession(response);
  }

  private async rotateRefreshCredentialAtomically(
    context: RefreshContext,
    nextCredential: IssuedRefreshCredential,
    requestMetadata: SessionRequestMetadata,
    now: Date,
  ): Promise<void> {
    await this.prisma.$transaction(async (transaction) => {
      const rotated = await transaction.session.updateMany({
        where: {
          id: context.session.id,
          refreshTokenHash: context.credentialHash,
          revokedAt: null,
          expiresAt: { gt: now },
        },
        data: {
          refreshTokenHash: nextCredential.hash,
          lastUsedAt: now,
          rotatedAt: now,
          userAgent: requestMetadata.userAgent,
          ipHash: requestMetadata.ipHash,
        },
      });
      if (rotated.count !== 1) throw new SessionRotationConflictError();

      if (context.parsedToken.tokenId) {
        const consumed = await transaction.sessionRefreshToken.updateMany({
          where: {
            id: context.parsedToken.tokenId,
            sessionId: context.session.id,
            credentialHash: context.credentialHash,
            consumedAt: null,
          },
          data: { consumedAt: now },
        });
        if (consumed.count !== 1) throw new SessionRotationConflictError();
      } else {
        // Legacy two-part cookies only have the hash stored on Session.
        await transaction.sessionRefreshToken.updateMany({
          where: { sessionId: context.session.id, consumedAt: null },
          data: { consumedAt: now },
        });
        await transaction.sessionRefreshToken.upsert({
          where: { id: context.session.id },
          create: {
            id: context.session.id,
            sessionId: context.session.id,
            credentialHash: context.credentialHash,
            consumedAt: now,
          },
          update: { credentialHash: context.credentialHash, consumedAt: now },
        });
      }

      await transaction.sessionRefreshToken.create({
        data: {
          id: nextCredential.tokenId,
          sessionId: context.session.id,
          credentialHash: nextCredential.hash,
        },
      });
    });
  }

  private async validateAccessToken(
    request: Request,
  ): Promise<AuthenticatedUser | null> {
    const accessToken = request.cookies?.[ACCESS_TOKEN_COOKIE];
    const payload = accessToken
      ? await this.sessionTokenService.verifyAccessToken(accessToken)
      : null;

    return payload
      ? this.prisma.user.findUnique({
          where: { publicId: payload.subject },
          select: authenticatedUserSelect,
        })
      : null;
  }

  private rejectSession(response: Response): never {
    this.sessionCookieService.clearAuthCookies(response);
    throw new UnauthorizedException();
  }
}
