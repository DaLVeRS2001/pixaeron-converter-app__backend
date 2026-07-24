import { BadRequestException, HttpException, HttpStatus } from '@nestjs/common';
import { hash } from 'bcryptjs';
import type { Request, Response } from 'express';

import { AuthService } from './auth.service';

describe('AuthService captcha policy', () => {
  const prisma = {};
  const userService = { getUser: jest.fn() };
  const sessionService = { createSession: jest.fn() };
  const sessionAuditService = { recordLoginFailed: jest.fn() };
  const captchaService = { isEnabled: jest.fn(), verify: jest.fn() };
  const googleAuthService = {};
  const loginAttemptService = {
    assertAllowed: jest.fn(),
    isCaptchaRequired: jest.fn(),
    recordFailure: jest.fn(),
    clear: jest.fn(),
  };
  const request = {} as Request;
  const response = {} as Response;
  const authenticatedUser = {
    id: 1,
    email: 'user@example.com',
    username: 'user',
  };
  let passwordHash: string;
  let service: AuthService;

  beforeAll(async () => {
    passwordHash = await hash('correct-password', 4);
  });

  beforeEach(() => {
    jest.clearAllMocks();
    captchaService.isEnabled.mockReturnValue(true);
    loginAttemptService.assertAllowed.mockResolvedValue(undefined);
    loginAttemptService.isCaptchaRequired.mockResolvedValue(false);
    loginAttemptService.clear.mockResolvedValue(undefined);
    userService.getUser.mockResolvedValue({
      ...authenticatedUser,
      password: passwordHash,
    });
    sessionService.createSession.mockResolvedValue(authenticatedUser);

    service = new AuthService(
      prisma as never,
      userService as never,
      sessionService as never,
      sessionAuditService as never,
      captchaService as never,
      googleAuthService as never,
      loginAttemptService as never,
    );
  });

  it('does not require captcha before the failed-password threshold', async () => {
    await expect(
      service.login(
        {
          email: ' USER@example.com ',
          password: 'correct-password',
        },
        request,
        response,
      ),
    ).resolves.toEqual(authenticatedUser);

    expect(captchaService.verify).not.toHaveBeenCalled();
    expect(loginAttemptService.clear).toHaveBeenCalledWith(
      'user@example.com',
      request,
    );
  });

  it('returns CAPTCHA_REQUIRED without checking the password after the threshold', async () => {
    loginAttemptService.isCaptchaRequired.mockResolvedValue(true);

    const result = service.login(
      { email: 'user@example.com', password: 'correct-password' },
      request,
      response,
    );

    await expect(result).rejects.toBeInstanceOf(BadRequestException);
    await expect(result).rejects.toMatchObject({
      response: expect.objectContaining({
        code: 'CAPTCHA_REQUIRED',
        action: 'login',
      }),
    });
    expect(userService.getUser).not.toHaveBeenCalled();
  });

  it('verifies a supplied token before checking credentials', async () => {
    loginAttemptService.isCaptchaRequired.mockResolvedValue(true);
    captchaService.verify.mockResolvedValue(undefined);

    await service.login(
      {
        email: 'user@example.com',
        password: 'correct-password',
        captchaToken: 'turnstile-token',
      },
      request,
      response,
    );

    expect(captchaService.verify).toHaveBeenCalledWith(
      'turnstile-token',
      request,
      'login',
    );
    expect(userService.getUser).toHaveBeenCalled();
  });

  it('asks for captcha on the failure that reaches the threshold', async () => {
    loginAttemptService.recordFailure.mockResolvedValue({
      pairAttempts: 3,
      ipAttempts: 3,
      captchaRequired: true,
    });

    const result = service.login(
      { email: 'user@example.com', password: 'wrong-password' },
      request,
      response,
    );

    await expect(result).rejects.toMatchObject({
      response: expect.objectContaining({
        code: 'CAPTCHA_REQUIRED',
        action: 'login',
      }),
    });
    expect(sessionAuditService.recordLoginFailed).toHaveBeenCalled();
    expect(loginAttemptService.assertAllowed).toHaveBeenCalledTimes(2);
  });

  it('returns a login block before another captcha challenge', async () => {
    loginAttemptService.recordFailure.mockResolvedValue({
      pairAttempts: 5,
      ipAttempts: 5,
      captchaRequired: true,
    });
    loginAttemptService.assertAllowed
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(
        new HttpException(
          { code: 'TOO_MANY_LOGIN_ATTEMPTS', retryAfter: 900 },
          HttpStatus.TOO_MANY_REQUESTS,
        ),
      );

    await expect(
      service.login(
        { email: 'user@example.com', password: 'wrong-password' },
        request,
        response,
      ),
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        code: 'TOO_MANY_LOGIN_ATTEMPTS',
      }),
    });
  });
});
