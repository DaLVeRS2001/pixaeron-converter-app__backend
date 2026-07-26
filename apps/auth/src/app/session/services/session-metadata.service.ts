import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac } from 'crypto';
import type { Request } from 'express';

const MAX_USER_AGENT_LENGTH = 512;

export interface SessionRequestMetadata {
  ipHash: string | null;
  userAgent: string | null;
}

@Injectable()
export class SessionMetadataService {
  constructor(private readonly configService: ConfigService) {}

  getFromRequest(request: Request): SessionRequestMetadata {
    const ip = this.getClientIp(request);

    return {
      ipHash: ip ? this.hashIp(ip) : null,
      userAgent: this.getUserAgent(request),
    };
  }

  private getClientIp(request: Request): string | null {
    return request.ip || request.socket.remoteAddress || null;
  }

  private getUserAgent(request: Request): string | null {
    const userAgent = request.headers['user-agent'];

    const value = Array.isArray(userAgent) ? userAgent[0] : userAgent;

    return value ? value.slice(0, MAX_USER_AGENT_LENGTH) : null;
  }

  private hashIp(ip: string): string {
    return createHmac('sha256', this.configService.getOrThrow('IP_HASH_SECRET'))
      .update(ip)
      .digest('hex');
  }
}
