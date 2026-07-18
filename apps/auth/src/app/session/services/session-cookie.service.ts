import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { CookieOptions, Response } from 'express';

import {
  ACCESS_TOKEN_COOKIE,
  REFRESH_TOKEN_COOKIE,
} from '../session.constants';

@Injectable()
export class SessionCookieService {
  constructor(private readonly configService: ConfigService) {}

  setAuthCookies(
    response: Response,
    accessToken: string,
    refreshToken: string,
    rememberMe: boolean,
  ) {
    response.cookie(ACCESS_TOKEN_COOKIE, accessToken, {
      ...this.getBaseCookieOptions(),
      ...(rememberMe
        ? { maxAge: Number(this.configService.getOrThrow('JWT_EXPIRATION_MS')) }
        : {}),
    });

    response.cookie(REFRESH_TOKEN_COOKIE, refreshToken, {
      ...this.getBaseCookieOptions(),
      ...(rememberMe
        ? {
            maxAge: Number(
              this.configService.getOrThrow('REFRESH_EXPIRATION_MS'),
            ),
          }
        : {}),
    });
  }

  clearAuthCookies(response: Response) {
    const options = this.getBaseCookieOptions();

    response.clearCookie(ACCESS_TOKEN_COOKIE, options);
    response.clearCookie(REFRESH_TOKEN_COOKIE, options);
  }

  private getBaseCookieOptions(): CookieOptions {
    return {
      httpOnly: true,
      secure: this.configService.get('NODE_ENV') === 'production',
      path: '/',
      sameSite: 'lax',
    };
  }
}
