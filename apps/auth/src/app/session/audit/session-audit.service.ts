import { Injectable } from '@nestjs/common';
import type { Request } from 'express';

import { Prisma, SessionEventType } from '../../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { SessionMetadataService } from '../services/session-metadata.service';

type SessionStartedEventType = 'LOGIN_SUCCESS' | 'REGISTER_SUCCESS';

@Injectable()
export class SessionAuditService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sessionMetadataService: SessionMetadataService,
  ) {}

  recordSessionStarted(
    type: SessionStartedEventType,
    sessionId: string,
    userId: number,
    request: Request,
  ) {
    return this.createEvent({ type, sessionId, userId, request });
  }

  recordLoginFailed(request: Request, userId?: number) {
    return this.createEvent({
      type: SessionEventType.LOGIN_FAILED,
      request,
      userId,
      metadata: { reason: 'invalid_credentials' },
    });
  }

  recordRefreshFailed(
    sessionId: string,
    userId: number,
    request: Request,
    reason: string,
  ) {
    return this.createEvent({
      type: SessionEventType.REFRESH_FAILED,
      sessionId,
      userId,
      request,
      metadata: { reason },
    });
  }

  recordSessionExpired(sessionId: string, userId: number, request: Request) {
    return this.createEvent({
      type: SessionEventType.SESSION_EXPIRED,
      sessionId,
      userId,
      request,
    });
  }

  recordRefreshReuseDetected(
    sessionId: string,
    userId: number,
    request: Request,
  ) {
    return this.createEvent({
      type: SessionEventType.REFRESH_REUSE_DETECTED,
      sessionId,
      userId,
      request,
    });
  }

  recordRefreshSuccess(sessionId: string, userId: number, request: Request) {
    return this.createEvent({
      type: SessionEventType.REFRESH_SUCCESS,
      sessionId,
      userId,
      request,
    });
  }

  recordLogout(sessionId: string, userId: number, request: Request) {
    return this.createEvent({
      type: SessionEventType.LOGOUT,
      sessionId,
      userId,
      request,
    });
  }

  recordLogoutAll(userId: number, request: Request, revokedSessions: number) {
    return this.createEvent({
      type: SessionEventType.LOGOUT_ALL,
      userId,
      request,
      metadata: { revokedSessions },
    });
  }

  recordSuspiciousIp(
    sessionId: string,
    userId: number,
    request: Request,
    reason: string,
  ) {
    return this.createEvent({
      type: SessionEventType.SUSPICIOUS_IP,
      sessionId,
      userId,
      request,
      metadata: { reason },
    });
  }

  recordSuspiciousUserAgent(
    sessionId: string,
    userId: number,
    request: Request,
    reason: string,
  ) {
    return this.createEvent({
      type: SessionEventType.SUSPICIOUS_USER_AGENT,
      sessionId,
      userId,
      request,
      metadata: { reason },
    });
  }

  private async createEvent({
    type,
    request,
    sessionId,
    userId,
    metadata,
  }: {
    type: SessionEventType;
    request: Request;
    sessionId?: string;
    userId?: number;
    metadata?: Prisma.InputJsonObject;
  }) {
    const requestMetadata = this.sessionMetadataService.getFromRequest(request);

    await this.prisma.sessionEvent.create({
      data: {
        type,
        sessionId,
        userId,
        userAgent: requestMetadata.userAgent,
        ipHash: requestMetadata.ipHash,
        metadata,
      },
    });
  }
}
