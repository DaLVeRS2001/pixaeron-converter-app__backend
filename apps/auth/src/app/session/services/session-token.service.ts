import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { hash } from 'bcryptjs';
import { randomBytes } from 'node:crypto';

import {
  ACCESS_TOKEN_ALGORITHM,
  ACCESS_TOKEN_TYPE,
} from '../constants/access-token.constants';
import { AccessTokenKeyService } from './access-token-key.service';

export interface AccessTokenPayload {
  subject: string;
}

type AccessTokenClaims = {
  aud?: unknown;
  exp?: unknown;
  iat?: unknown;
  iss?: unknown;
  sub?: unknown;
};

type DecodedAccessToken = {
  header: {
    alg?: string;
    kid?: string;
    typ?: string;
  };
};

@Injectable()
export class SessionTokenService {
  private readonly audience: string;
  private readonly expiresInSeconds: number;
  private readonly issuer: string;

  constructor(
    private readonly configService: ConfigService,
    private readonly jwtService: JwtService,
    private readonly accessTokenKeys: AccessTokenKeyService,
  ) {
    this.audience = configService.getOrThrow('JWT_AUDIENCE');
    this.expiresInSeconds = Math.floor(
      Number(configService.getOrThrow('JWT_EXPIRATION_MS')) / 1000,
    );
    this.issuer = configService.getOrThrow('JWT_ISSUER');
  }

  signAccessToken(subject: string): string {
    return this.jwtService.sign(
      {},
      {
        algorithm: ACCESS_TOKEN_ALGORITHM,
        audience: this.audience,
        expiresIn: this.expiresInSeconds,
        header: {
          alg: ACCESS_TOKEN_ALGORITHM,
          kid: this.accessTokenKeys.getActiveKid(),
          typ: ACCESS_TOKEN_TYPE,
        },
        issuer: this.issuer,
        privateKey: this.accessTokenKeys.getSigningKey(),
        subject,
      },
    );
  }

  async verifyAccessToken(
    accessToken: string,
  ): Promise<AccessTokenPayload | null> {
    try {
      const decoded = this.jwtService.decode<DecodedAccessToken>(accessToken, {
        complete: true,
      });
      const { alg, kid, typ } = decoded.header;

      if (
        alg !== ACCESS_TOKEN_ALGORITHM ||
        typ !== ACCESS_TOKEN_TYPE ||
        typeof kid !== 'string'
      ) {
        return null;
      }

      const publicKey = this.accessTokenKeys.getVerificationKey(kid);
      if (!publicKey) return null;

      const claims = await this.jwtService.verifyAsync<AccessTokenClaims>(
        accessToken,
        {
          algorithms: [ACCESS_TOKEN_ALGORITHM],
          audience: this.audience,
          issuer: this.issuer,
          publicKey,
        },
      );

      if (
        claims.iss !== this.issuer ||
        claims.aud !== this.audience ||
        typeof claims.sub !== 'string' ||
        claims.sub.length === 0 ||
        !Number.isInteger(claims.iat) ||
        !Number.isInteger(claims.exp) ||
        (claims.exp as number) <= (claims.iat as number)
      ) {
        return null;
      }

      return { subject: claims.sub };
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
