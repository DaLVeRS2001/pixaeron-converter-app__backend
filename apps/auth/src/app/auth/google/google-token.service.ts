import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OAuth2Client } from 'google-auth-library';

import { normalizeEmail } from '../helpers/normalize-email';

interface GoogleUserProfile {
  providerAccountId: string;
  email: string;
  emailVerified: boolean;
  username: string;
}

@Injectable()
export class GoogleTokenService {
  private readonly clientId: string;
  private readonly client: OAuth2Client;

  constructor(configService: ConfigService) {
    this.clientId = configService.getOrThrow('GOOGLE_CLIENT_ID');
    this.client = new OAuth2Client(this.clientId);
  }

  async verifyIdToken(idToken: string): Promise<GoogleUserProfile> {
    try {
      const ticket = await this.client.verifyIdToken({
        idToken,
        audience: this.clientId,
      });
      const payload = ticket.getPayload();

      if (!payload?.sub || !payload.email) {
        throw new Error('Google token payload is incomplete');
      }

      const email = normalizeEmail(payload.email);
      const username = (payload.name?.trim() || email.split('@')[0])
        .replace(/\s+/g, ' ')
        .slice(0, 32)
        .trim();

      return {
        providerAccountId: payload.sub,
        email,
        emailVerified: payload.email_verified === true,
        username: username.length >= 3 ? username : 'Google user',
      };
    } catch {
      throw new UnauthorizedException({
        code: 'GOOGLE_TOKEN_INVALID',
        message: 'Google sign-in token is invalid or expired',
      });
    }
  }
}
