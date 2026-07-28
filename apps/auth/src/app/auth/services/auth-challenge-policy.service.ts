import { BadRequestException, Injectable } from '@nestjs/common';
import { CaptchaService } from '@pixaeron/captcha';
import type { Request } from 'express';

import {
  EmailAction,
  EmailActionAttemptService,
} from '../email/email-action-attempt.service';
import { LoginAttemptService } from '../password/login-attempt.service';

type AuthCaptchaAction = EmailAction | 'google_login' | 'login' | 'register';

@Injectable()
export class AuthChallengePolicyService {
  constructor(
    private readonly captchaService: CaptchaService,
    private readonly loginAttemptService: LoginAttemptService,
    private readonly emailActionAttemptService: EmailActionAttemptService,
  ) {}

  async requireLoginCaptchaIfNeeded(
    email: string,
    token: string | undefined,
    request: Request,
  ): Promise<void> {
    if (
      this.captchaService.isEnabled() &&
      (await this.loginAttemptService.isCaptchaRequired(email, request))
    ) {
      await this.requireCaptcha(token, request, 'login');
    }
  }

  async prepareEmailAction(
    action: EmailAction,
    email: string,
    token: string | undefined,
    request: Request,
  ): Promise<void> {
    await this.emailActionAttemptService.assertAllowed(action, email, request);

    if (
      this.captchaService.isEnabled() &&
      (await this.emailActionAttemptService.isCaptchaRequired(
        action,
        email,
        request,
      ))
    ) {
      await this.requireCaptcha(token, request, action);
    }

    await this.emailActionAttemptService.reserve(action, email, request);
  }

  async requireCaptcha(
    token: string | undefined,
    request: Request,
    action: AuthCaptchaAction,
  ): Promise<void> {
    if (!this.captchaService.isEnabled()) return;

    if (!token) this.throwCaptchaRequired(action);

    await this.captchaService.verify(token, request, action);
  }

  throwIfCaptchaRequiredAfterLoginFailure(captchaRequired: boolean): void {
    if (this.captchaService.isEnabled() && captchaRequired) {
      this.throwCaptchaRequired('login');
    }
  }

  private throwCaptchaRequired(action: AuthCaptchaAction): never {
    throw new BadRequestException({
      code: 'CAPTCHA_REQUIRED',
      action,
      message: 'Captcha verification is required',
    });
  }
}
