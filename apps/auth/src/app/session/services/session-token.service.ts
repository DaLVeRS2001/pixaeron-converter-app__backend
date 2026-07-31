import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { compare, hash } from 'bcryptjs';
import { randomBytes, randomUUID } from 'node:crypto';

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

export type IssuedRefreshCredential = {
  credential: string;
  hash: string;
  tokenId: string;
};

export type ParsedRefreshToken = {
  sessionId: string;
  tokenId: string;
  refreshCredential: string;
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

      const hasExpectedIssuer = claims.iss === this.issuer;
      const hasExpectedAudience = claims.aud === this.audience;
      const subject = typeof claims.sub === 'string' ? claims.sub : '';
      const hasValidSubject = subject.length > 0;
      const issuedAt = typeof claims.iat === 'number' ? claims.iat : NaN;
      const expiresAt = typeof claims.exp === 'number' ? claims.exp : NaN;
      const hasValidTimestamps =
        Number.isInteger(issuedAt) &&
        Number.isInteger(expiresAt) &&
        expiresAt > issuedAt;

      if (
        !hasExpectedIssuer ||
        !hasExpectedAudience ||
        !hasValidSubject ||
        !hasValidTimestamps
      ) {
        return null;
      }

      return { subject };
    } catch {
      return null;
    }
  }

  async issueRefreshCredential(): Promise<IssuedRefreshCredential> {
    const tokenId = randomUUID();
    const credential = `${tokenId}.${this.generateRefreshSecret()}`;

    return {
      credential,
      hash: await this.hashRefreshCredential(credential),
      tokenId,
    };
  }

  verifyRefreshCredential(
    credential: string,
    credentialHash: string,
  ): Promise<boolean> {
    return compare(credential, credentialHash);
  }

  parseRefreshToken(refreshToken?: string): ParsedRefreshToken | null {
    const parts = refreshToken?.split('.');
    if (parts?.length !== 3 || !parts.every(Boolean)) return null;

    const [sessionId, tokenId, secret] = parts;

    return {
      sessionId,
      tokenId,
      refreshCredential: `${tokenId}.${secret}`,
    };
  }

  getRefreshExpiresAt(now: Date, rememberMe: boolean): Date {
    const envKey = rememberMe
      ? 'REFRESH_EXPIRATION_MS'
      : 'SESSION_REFRESH_EXPIRATION_MS';

    return new Date(
      now.getTime() + Number(this.configService.getOrThrow(envKey)),
    );
  }

  private generateRefreshSecret(): string {
    return randomBytes(64).toString('base64url');
  }

  private hashRefreshCredential(refreshCredential: string): Promise<string> {
    return hash(
      refreshCredential,
      Number(this.configService.getOrThrow('REFRESH_TOKEN_HASH_ROUNDS')),
    );
  }
}
