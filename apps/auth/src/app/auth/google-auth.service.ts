import { BadRequestException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OAuth2Client } from 'google-auth-library';

export interface GoogleUserProfile {
  providerAccountId: string;
  email: string;
  emailVerified: boolean;
  username: string;
}

@Injectable()
export class GoogleAuthService {
  constructor(private readonly configService: ConfigService) {}

  async verifyIdToken(idToken: string): Promise<GoogleUserProfile> {
    const clientId = this.configService.getOrThrow('GOOGLE_CLIENT_ID');
    const ticket = await new OAuth2Client(clientId).verifyIdToken({
      idToken,
      audience: clientId,
    });
    const payload = ticket.getPayload();

    if (!payload?.sub || !payload.email) {
      throw new BadRequestException('Invalid Google token payload');
    }

    return {
      providerAccountId: payload.sub,
      email: payload.email.toLowerCase(),
      emailVerified: payload.email_verified === true,
      username: payload.name || payload.email.split('@')[0],
    };
  }
}
