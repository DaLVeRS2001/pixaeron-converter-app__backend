import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { compare } from 'bcryptjs';
import type { Request, Response } from 'express';

import { SessionRevokedReason } from '../../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import {
  AuthenticatedUser,
  authenticatedUserSelect,
} from '../../user/prisma/user.select';
import { SessionAuditService } from '../audit/session-audit.service';
import {
  ACCESS_TOKEN_COOKIE,
  REFRESH_TOKEN_COOKIE,
} from '../constants/session.constants';
import { SessionCookieService } from './session-cookie.service';
import { SessionMetadataService } from './session-metadata.service';
import { SessionTokenService } from './session-token.service';

type SessionStartedEventType = 'LOGIN_SUCCESS' | 'REGISTER_SUCCESS';

export class SessionCredentialChangedError extends Error {}

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
    const refreshSecret = this.sessionTokenService.generateRefreshSecret();
    const refreshTokenHash =
      await this.sessionTokenService.hashRefreshSecret(refreshSecret);
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
            refreshTokenHash,
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
      `${session.id}.${refreshSecret}`,
      rememberMe,
    );

    return user;
  }

  async authenticateRequest(
    request: Request,
    response: Response,
  ): Promise<AuthenticatedUser> {
    const accessToken = request.cookies?.[ACCESS_TOKEN_COOKIE];
    const user = accessToken
      ? await this.validateAccessToken(accessToken)
      : null;

    return user ?? this.refreshSession(request, response);
  }

  async refreshSession(
    request: Request,
    response: Response,
  ): Promise<AuthenticatedUser> {
    const parsedToken = this.sessionTokenService.parseRefreshToken(
      request.cookies?.[REFRESH_TOKEN_COOKIE],
    );
    if (!parsedToken) return this.rejectSession(response);

    const session = await this.prisma.session.findUnique({
      where: { id: parsedToken.sessionId },
      include: { user: { select: authenticatedUserSelect } },
    });
    if (!session) return this.rejectSession(response);

    const user = session.user;

    const now = new Date();
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

    const validSecret = await compare(
      parsedToken.refreshSecret,
      session.refreshTokenHash,
    );
    if (!validSecret) {
      await this.sessionAuditService.recordRefreshFailed(
        session.id,
        session.userId,
        request,
        'invalid_refresh_secret',
      );
      throw new UnauthorizedException();
    }

    const nextSecret = this.sessionTokenService.generateRefreshSecret();
    const nextHash =
      await this.sessionTokenService.hashRefreshSecret(nextSecret);
    const requestMetadata = this.sessionMetadataService.getFromRequest(request);
    const rotated = await this.prisma.session.updateMany({
      where: {
        id: session.id,
        refreshTokenHash: session.refreshTokenHash,
        revokedAt: null,
        expiresAt: { gt: now },
      },
      data: {
        refreshTokenHash: nextHash,
        lastUsedAt: now,
        rotatedAt: now,
        userAgent: requestMetadata.userAgent,
        ipHash: requestMetadata.ipHash,
      },
    });

    if (rotated.count !== 1) {
      await this.sessionAuditService.recordRefreshFailed(
        session.id,
        session.userId,
        request,
        'concurrent_refresh_rotation',
      );
      throw new UnauthorizedException();
    }

    this.sessionCookieService.setAuthCookies(
      response,
      this.sessionTokenService.signAccessToken(user.publicId),
      `${session.id}.${nextSecret}`,
      session.rememberMe,
    );

    try {
      await this.sessionAuditService.recordRefreshMetadataChanges({
        sessionId: session.id,
        userId: session.userId,
        previousIpHash: session.ipHash,
        previousUserAgent: session.userAgent,
        currentMetadata: requestMetadata,
        request,
      });
      await this.sessionAuditService.recordRefreshSuccess(
        session.id,
        session.userId,
        request,
      );
    } catch {
      this.logger.error('Failed to record successful session refresh audit');
    }

    return user;
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
        (await compare(parsedToken.refreshSecret, session.refreshTokenHash));

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

  private rejectSession(response: Response): never {
    this.sessionCookieService.clearAuthCookies(response);
    throw new UnauthorizedException();
  }

  private getAuthenticatedUser(publicId: string) {
    return this.prisma.user.findUnique({
      where: { publicId },
      select: authenticatedUserSelect,
    });
  }

  private async validateAccessToken(
    accessToken: string,
  ): Promise<AuthenticatedUser | null> {
    const payload =
      await this.sessionTokenService.verifyAccessToken(accessToken);

    return payload ? this.getAuthenticatedUser(payload.subject) : null;
  }
}
