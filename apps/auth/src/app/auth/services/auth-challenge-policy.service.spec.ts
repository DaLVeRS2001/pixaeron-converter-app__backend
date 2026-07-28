import { BadRequestException } from '@nestjs/common';
import type { Request } from 'express';

import { AuthChallengePolicyService } from './auth-challenge-policy.service';

describe('AuthChallengePolicyService', () => {
  const captchaService = { isEnabled: jest.fn(), verify: jest.fn() };
  const loginAttemptService = { isCaptchaRequired: jest.fn() };
  const emailActionAttemptService = {
    assertAllowed: jest.fn(),
    isCaptchaRequired: jest.fn(),
    reserve: jest.fn(),
  };
  const request = {} as Request;
  const service = new AuthChallengePolicyService(
    captchaService as never,
    loginAttemptService as never,
    emailActionAttemptService as never,
  );

  beforeEach(() => {
    jest.clearAllMocks();
    captchaService.isEnabled.mockReturnValue(true);
    loginAttemptService.isCaptchaRequired.mockResolvedValue(false);
    emailActionAttemptService.assertAllowed.mockResolvedValue(undefined);
    emailActionAttemptService.isCaptchaRequired.mockResolvedValue(false);
    emailActionAttemptService.reserve.mockResolvedValue(undefined);
  });

  it('does not require captcha before the failed-password threshold', async () => {
    await service.requireLoginCaptchaIfNeeded(
      'user@example.com',
      undefined,
      request,
    );

    expect(captchaService.verify).not.toHaveBeenCalled();
  });

  it('returns CAPTCHA_REQUIRED before credential lookup after the threshold', async () => {
    loginAttemptService.isCaptchaRequired.mockResolvedValue(true);

    await expect(
      service.requireLoginCaptchaIfNeeded(
        'user@example.com',
        undefined,
        request,
      ),
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        code: 'CAPTCHA_REQUIRED',
        action: 'login',
      }),
    });
    expect(captchaService.verify).not.toHaveBeenCalled();
  });

  it('verifies a supplied login token with the exact action', async () => {
    loginAttemptService.isCaptchaRequired.mockResolvedValue(true);
    captchaService.verify.mockResolvedValue(undefined);

    await service.requireLoginCaptchaIfNeeded(
      'user@example.com',
      'turnstile-token',
      request,
    );

    expect(captchaService.verify).toHaveBeenCalledWith(
      'turnstile-token',
      request,
      'login',
    );
  });

  it('reserves an email action only after its adaptive challenge passes', async () => {
    emailActionAttemptService.isCaptchaRequired.mockResolvedValue(true);
    captchaService.verify.mockResolvedValue(undefined);

    await service.prepareEmailAction(
      'forgot_password',
      'user@example.com',
      'turnstile-token',
      request,
    );

    expect(emailActionAttemptService.assertAllowed).toHaveBeenCalledWith(
      'forgot_password',
      'user@example.com',
      request,
    );
    expect(captchaService.verify).toHaveBeenCalledWith(
      'turnstile-token',
      request,
      'forgot_password',
    );
    expect(emailActionAttemptService.reserve).toHaveBeenCalledWith(
      'forgot_password',
      'user@example.com',
      request,
    );
  });

  it('does not reserve an email action when captcha is missing', async () => {
    emailActionAttemptService.isCaptchaRequired.mockResolvedValue(true);

    await expect(
      service.prepareEmailAction(
        'resend_confirmation',
        'user@example.com',
        undefined,
        request,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(emailActionAttemptService.reserve).not.toHaveBeenCalled();
  });

  it('requires captcha on a failed login that reaches the threshold', () => {
    expect(() => service.throwIfCaptchaRequiredAfterLoginFailure(true)).toThrow(
      BadRequestException,
    );
  });

  it('does not require a challenge when captcha is disabled', async () => {
    captchaService.isEnabled.mockReturnValue(false);

    await service.requireCaptcha(undefined, request, 'register');
    service.throwIfCaptchaRequiredAfterLoginFailure(true);

    expect(captchaService.verify).not.toHaveBeenCalled();
  });
});
