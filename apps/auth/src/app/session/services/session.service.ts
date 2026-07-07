import { Injectable, UnauthorizedException } from '@nestjs/common';
import type { Request, Response } from 'express';

import { SessionRevokedReason } from '../../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import {
  AuthenticatedUser,
  authenticatedUserSelect,
} from '../../user/prisma/user.select';
import {
  ACCESS_TOKEN_COOKIE,
  REFRESH_TOKEN_COOKIE,
} from '../session.constants';
import { SessionAuditService } from '../audit/session-audit.service';
import { SessionRiskAuditService } from '../audit/session-risk-audit.service';
import { SessionCookieService } from './session-cookie.service';
import { SessionMetadataService } from './session-metadata.service';
import { SessionTokenService } from './session-token.service';
import { compare } from 'bcryptjs';

type SessionStartedEventType = 'LOGIN_SUCCESS' | 'REGISTER_SUCCESS';

@Injectable()
export class SessionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sessionTokenService: SessionTokenService,
    private readonly sessionCookieService: SessionCookieService,
    private readonly sessionMetadataService: SessionMetadataService,
    private readonly sessionAuditService: SessionAuditService,
    private readonly sessionRiskAuditService: SessionRiskAuditService,
  ) {}

  async createSession(
    userId: number,
    request: Request,
    response: Response,
    eventType: SessionStartedEventType,
    rememberMe = false,
  ): Promise<AuthenticatedUser> {
    const now = new Date();
    const refreshSecret = this.sessionTokenService.generateRefreshSecret();
    const requestMetadata = this.sessionMetadataService.getFromRequest(request);

    const session = await this.prisma.session.create({
      data: {
        userId,
        refreshTokenHash:
          await this.sessionTokenService.hashRefreshSecret(refreshSecret),
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
    );

    this.sessionCookieService.setAuthCookies(
      response,
      this.sessionTokenService.signAccessToken(userId),
      `${session.id}.${refreshSecret}`,
      rememberMe,
    );

    const user = await this.getAuthenticatedUser(userId);

    if (!user) throw new UnauthorizedException();

    return user;
  }

  async authenticateRequest(
    request: Request,
    response: Response,
  ): Promise<AuthenticatedUser> {
    const accessToken = request.cookies?.[ACCESS_TOKEN_COOKIE];

    if (accessToken) {
      const user = await this.validateAccessToken(accessToken);

      if (user) return user;
    }

    return this.refreshSession(request, response);
  }

  async refreshSession(
    request: Request,
    response: Response,
  ): Promise<AuthenticatedUser> {
    const parsedRefreshToken = this.sessionTokenService.parseRefreshToken(
      request.cookies?.[REFRESH_TOKEN_COOKIE],
    );

    if (!parsedRefreshToken) {
      this.sessionCookieService.clearAuthCookies(response);
      throw new UnauthorizedException();
    }

    const { sessionId, refreshSecret } = parsedRefreshToken;
    const session = await this.prisma.session.findUnique({
      where: { id: sessionId },
    });

    if (!session) {
      this.sessionCookieService.clearAuthCookies(response);
      throw new UnauthorizedException();
    }

    if (session.revokedAt) {
      await this.sessionAuditService.recordRefreshFailed(
        session.id,
        session.userId,
        request,
        'session_revoked',
      );
      this.sessionCookieService.clearAuthCookies(response);
      throw new UnauthorizedException();
    }

    const now = new Date();

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
      this.sessionCookieService.clearAuthCookies(response);
      throw new UnauthorizedException();
    }

    const isRefreshTokenValid = await compare(
      refreshSecret,
      session.refreshTokenHash,
    );

    if (!isRefreshTokenValid) {
      await this.prisma.session.update({
        where: { id: session.id },
        data: {
          revokedAt: now,
          revokedReason: SessionRevokedReason.REFRESH_REUSE,
        },
      });
      await this.sessionAuditService.recordRefreshReuseDetected(
        session.id,
        session.userId,
        request,
      );
      this.sessionCookieService.clearAuthCookies(response);
      throw new UnauthorizedException();
    }

    const nextRefreshSecret = this.sessionTokenService.generateRefreshSecret();
    const requestMetadata = this.sessionMetadataService.getFromRequest(request);

    await this.sessionRiskAuditService.recordRefreshMetadataChanges({
      sessionId: session.id,
      userId: session.userId,
      previousIpHash: session.ipHash,
      previousUserAgent: session.userAgent,
      currentMetadata: requestMetadata,
      request,
    });

    await this.prisma.session.update({
      where: { id: session.id },
      data: {
        refreshTokenHash:
          await this.sessionTokenService.hashRefreshSecret(nextRefreshSecret),
        lastUsedAt: now,
        rotatedAt: now,
        userAgent: requestMetadata.userAgent,
        ipHash: requestMetadata.ipHash,
      },
    });

    await this.sessionAuditService.recordRefreshSuccess(
      session.id,
      session.userId,
      request,
    );

    this.sessionCookieService.setAuthCookies(
      response,
      this.sessionTokenService.signAccessToken(session.userId),
      `${session.id}.${nextRefreshSecret}`,
      session.rememberMe,
    );

    const user = await this.getAuthenticatedUser(session.userId);

    if (!user) throw new UnauthorizedException();

    return user;
  }

  async logout(request: Request, response: Response): Promise<boolean> {
    const parsedRefreshToken = this.sessionTokenService.parseRefreshToken(
      request.cookies?.[REFRESH_TOKEN_COOKIE],
    );

    if (parsedRefreshToken) {
      const session = await this.prisma.session.findUnique({
        where: { id: parsedRefreshToken.sessionId },
      });

      if (session && !session.revokedAt) {
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
      }
    }

    this.sessionCookieService.clearAuthCookies(response);

    return true;
  }

  async logoutAll(
    userId: number,
    request: Request,
    response: Response,
  ): Promise<boolean> {
    const result = await this.prisma.session.updateMany({
      where: {
        userId,
        revokedAt: null,
      },
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
    this.sessionCookieService.clearAuthCookies(response);

    return true;
  }

  private getAuthenticatedUser(userId: number) {
    return this.prisma.user.findUnique({
      where: { id: userId },
      select: authenticatedUserSelect,
    });
  }

  private async validateAccessToken(
    accessToken: string,
  ): Promise<AuthenticatedUser | null> {
    const payload =
      await this.sessionTokenService.verifyAccessToken(accessToken);

    if (!payload) return null;

    return this.getAuthenticatedUser(payload.userId);
  }
}
