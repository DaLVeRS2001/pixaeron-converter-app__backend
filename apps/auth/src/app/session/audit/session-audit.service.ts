import { Injectable } from '@nestjs/common';
import type { Request } from 'express';

import { Prisma, SessionEventType } from '../../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import {
  SessionMetadataService,
  SessionRequestMetadata,
} from '../services/session-metadata.service';

type SessionStartedEventType = 'LOGIN_SUCCESS' | 'REGISTER_SUCCESS';
type SessionEventClient = Pick<Prisma.TransactionClient, 'sessionEvent'>;

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
    client?: SessionEventClient,
  ) {
    return this.createEvent({ type, sessionId, userId, request, client });
  }

  recordSecurityEvent(
    type: SessionEventType,
    request: Request,
    userId?: number,
    metadata?: Prisma.InputJsonObject,
    client?: SessionEventClient,
  ) {
    return this.createEvent({ type, request, userId, metadata, client });
  }

  recordPasswordChanged(
    userId: number,
    request: Request,
    revokedSessions: number,
    client?: SessionEventClient,
  ) {
    return this.createEvent({
      type: SessionEventType.PASSWORD_CHANGED,
      userId,
      request,
      metadata: { revokedSessions },
      client,
    });
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

  recordRefreshSuccess(sessionId: string, userId: number, request: Request) {
    return this.createEvent({
      type: SessionEventType.REFRESH_SUCCESS,
      sessionId,
      userId,
      request,
    });
  }

  async recordRefreshMetadataChanges({
    sessionId,
    userId,
    previousIpHash,
    previousUserAgent,
    currentMetadata,
    request,
  }: {
    sessionId: string;
    userId: number;
    previousIpHash: string | null;
    previousUserAgent: string | null;
    currentMetadata: SessionRequestMetadata;
    request: Request;
  }): Promise<void> {
    const events: Promise<void>[] = [];

    if (
      previousIpHash &&
      currentMetadata.ipHash &&
      previousIpHash !== currentMetadata.ipHash
    ) {
      events.push(
        this.createEvent({
          type: SessionEventType.SUSPICIOUS_IP,
          sessionId,
          userId,
          request,
          metadata: { reason: 'ip_changed' },
        }),
      );
    }

    if (
      previousUserAgent &&
      currentMetadata.userAgent &&
      previousUserAgent !== currentMetadata.userAgent
    ) {
      events.push(
        this.createEvent({
          type: SessionEventType.SUSPICIOUS_USER_AGENT,
          sessionId,
          userId,
          request,
          metadata: { reason: 'user_agent_changed' },
        }),
      );
    }

    await Promise.all(events);
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

  private async createEvent({
    type,
    request,
    sessionId,
    userId,
    metadata,
    client,
  }: {
    type: SessionEventType;
    request: Request;
    sessionId?: string;
    userId?: number;
    metadata?: Prisma.InputJsonObject;
    client?: SessionEventClient;
  }): Promise<void> {
    const requestMetadata = this.sessionMetadataService.getFromRequest(request);

    await (client ?? this.prisma).sessionEvent.create({
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
