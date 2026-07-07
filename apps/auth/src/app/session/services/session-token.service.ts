import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { hash } from 'bcryptjs';
import { randomBytes } from 'crypto';

import { TokenPayload } from '../../auth/interfaces/token-payload.interface';

@Injectable()
export class SessionTokenService {
  constructor(
    private readonly configService: ConfigService,
    private readonly jwtService: JwtService,
  ) {}

  signAccessToken(userId: number): string {
    return this.jwtService.sign({ userId } satisfies TokenPayload);
  }

  async verifyAccessToken(accessToken: string): Promise<TokenPayload | null> {
    try {
      return await this.jwtService.verifyAsync<TokenPayload>(accessToken, {
        secret: this.configService.getOrThrow('JWT_SECRET'),
      });
    } catch {
      return null;
    }
  }

  parseRefreshToken(refreshToken?: string) {
    if (!refreshToken) return null;

    const separatorIndex = refreshToken.indexOf('.');

    if (separatorIndex <= 0 || separatorIndex === refreshToken.length - 1)
      return null;

    return {
      sessionId: refreshToken.slice(0, separatorIndex),
      refreshSecret: refreshToken.slice(separatorIndex + 1),
    };
  }

  generateRefreshSecret(): string {
    return randomBytes(64).toString('base64url');
  }

  hashRefreshSecret(refreshSecret: string): Promise<string> {
    return hash(
      refreshSecret,
      Number(this.configService.getOrThrow('REFRESH_TOKEN_HASH_ROUNDS')),
    );
  }

  getRefreshExpiresAt(now: Date, rememberMe: boolean): Date {
    const envKey = rememberMe
      ? 'REFRESH_EXPIRATION_MS'
      : 'SESSION_REFRESH_EXPIRATION_MS';

    return new Date(
      now.getTime() + Number(this.configService.getOrThrow(envKey)),
    );
  }
}
