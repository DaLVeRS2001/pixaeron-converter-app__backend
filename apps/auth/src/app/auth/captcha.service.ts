import { BadRequestException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import type { Request } from 'express';

@Injectable()
export class CaptchaService {
  constructor(private readonly configService: ConfigService) {}

  async verify(token: string | undefined, request: Request, action?: string) {
    if (this.configService.get('CAPTCHA_ENABLED') !== 'true') return;
    if (!token) throw new BadRequestException('Captcha is required');

    const provider = this.configService.get('CAPTCHA_PROVIDER') ?? 'recaptcha';
    const secret = this.configService.getOrThrow('CAPTCHA_SECRET_KEY');
    const verifyUrl =
      provider === 'turnstile'
        ? 'https://challenges.cloudflare.com/turnstile/v0/siteverify'
        : 'https://www.google.com/recaptcha/api/siteverify';

    const params = new URLSearchParams({
      secret,
      response: token,
    });

    const ip = request.ip || request.socket.remoteAddress;
    if (ip) params.set('remoteip', ip);

    const { data } = await axios.post(verifyUrl, params, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });

    if (!data.success)
      throw new BadRequestException('Captcha verification failed');

    const expectedHostname = this.configService.get('CAPTCHA_HOSTNAME');
    if (expectedHostname && data.hostname !== expectedHostname) {
      throw new BadRequestException('Captcha hostname mismatch');
    }

    if (action && data.action && data.action !== action) {
      throw new BadRequestException('Captcha action mismatch');
    }

    const minScore = Number(this.configService.get('CAPTCHA_MIN_SCORE') ?? 0);
    if (data.score !== undefined && data.score < minScore) {
      throw new BadRequestException('Captcha score is too low');
    }
  }
}
