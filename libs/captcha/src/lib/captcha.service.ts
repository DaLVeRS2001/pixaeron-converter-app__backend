import {
  BadRequestException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
export interface CaptchaRequest {
  ip?: string;
  socket: { remoteAddress?: string };
}

const TURNSTILE_SITEVERIFY_URL =
  'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const TURNSTILE_TOKEN_MAX_LENGTH = 2048;
const TURNSTILE_TIMEOUT_MS = 5_000;

interface TurnstileSiteverifyResponse {
  success: boolean;
  hostname?: string;
  action?: string;
  'error-codes'?: string[];
}

@Injectable()
export class CaptchaService {
  constructor(private readonly configService: ConfigService) {}

  isEnabled(): boolean {
    return this.configService.get('CAPTCHA_ENABLED') === 'true';
  }

  async verify(
    token: string,
    request: CaptchaRequest,
    expectedAction: string,
  ): Promise<void> {
    if (!this.isEnabled()) return;

    if (!token || token.length > TURNSTILE_TOKEN_MAX_LENGTH) {
      throw new BadRequestException({
        code: 'CAPTCHA_INVALID',
        message: 'Captcha verification failed',
      });
    }

    const params = new URLSearchParams({
      secret: this.configService.getOrThrow<string>('CAPTCHA_SECRET_KEY'),
      response: token,
    });
    const ip = request.ip || request.socket.remoteAddress;

    if (ip) params.set('remoteip', ip);

    let data: TurnstileSiteverifyResponse;

    try {
      const response = await axios.post<TurnstileSiteverifyResponse>(
        TURNSTILE_SITEVERIFY_URL,
        params,
        {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          timeout: TURNSTILE_TIMEOUT_MS,
        },
      );
      data = response.data;
    } catch {
      throw new ServiceUnavailableException({
        code: 'CAPTCHA_UNAVAILABLE',
        message: 'Captcha verification is temporarily unavailable',
      });
    }

    const expectedHostname = this.configService.get<string>('CAPTCHA_HOSTNAME');

    if (
      data.success !== true ||
      data.action !== expectedAction ||
      (expectedHostname && data.hostname !== expectedHostname)
    ) {
      throw new BadRequestException({
        code: 'CAPTCHA_INVALID',
        message: 'Captcha verification failed',
      });
    }
  }
}
