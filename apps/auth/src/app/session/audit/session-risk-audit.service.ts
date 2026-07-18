import { Injectable } from '@nestjs/common';
import type { Request } from 'express';

import { SessionRequestMetadata } from '../services/session-metadata.service';
import { SessionAuditService } from './session-audit.service';

@Injectable()
export class SessionRiskAuditService {
  constructor(private readonly sessionAuditService: SessionAuditService) {}

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
  }) {
    if (
      previousIpHash &&
      currentMetadata.ipHash &&
      previousIpHash !== currentMetadata.ipHash
    ) {
      await this.sessionAuditService.recordSuspiciousIp(
        sessionId,
        userId,
        request,
        'ip_changed',
      );
    }
    if (
      previousUserAgent &&
      currentMetadata.userAgent &&
      previousUserAgent !== currentMetadata.userAgent
    ) {
      await this.sessionAuditService.recordSuspiciousUserAgent(
        sessionId,
        userId,
        request,
        'user_agent_changed',
      );
    }
  }
}
