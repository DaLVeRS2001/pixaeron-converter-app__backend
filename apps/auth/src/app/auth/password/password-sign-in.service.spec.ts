import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';

import { SessionCredentialChangedError } from '../../session/services/session.service';
import { PasswordSignInService } from './password-sign-in.service';

describe('PasswordSignInService', () => {
  const userService = { getUser: jest.fn(), verifyPassword: jest.fn() };
  const sessionService = { createSession: jest.fn() };
  const sessionAuditService = {
    recordLoginFailed: jest.fn(),
    recordSecurityEvent: jest.fn(),
  };
  const loginAttemptService = {
    assertAllowed: jest.fn(),
    recordFailure: jest.fn(),
    clear: jest.fn(),
  };
  const challengePolicy = {
    requireLoginCaptchaIfNeeded: jest.fn(),
    throwIfCaptchaRequiredAfterLoginFailure: jest.fn(),
  };
  const request = {} as Request;
  const response = {} as Response;
  const authenticatedUser = {
    id: 1,
    email: 'user@example.com',
    username: 'user',
    emailVerified: true,
  };
  const passwordHash = 'stored-password-hash';
  let service: PasswordSignInService;

  beforeAll(() => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterAll(() => {
    jest.restoreAllMocks();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    userService.getUser.mockResolvedValue({
      ...authenticatedUser,
      password: passwordHash,
    });
    userService.verifyPassword.mockImplementation(
      (password: string, storedHash: string | null | undefined) =>
        Promise.resolve(Boolean(storedHash) && password === 'correct-password'),
    );
    sessionService.createSession.mockResolvedValue(authenticatedUser);
    sessionAuditService.recordLoginFailed.mockResolvedValue(undefined);
    sessionAuditService.recordSecurityEvent.mockResolvedValue(undefined);
    loginAttemptService.assertAllowed.mockResolvedValue(undefined);
    loginAttemptService.recordFailure.mockResolvedValue({
      pairAttempts: 1,
      ipAttempts: 1,
      captchaRequired: false,
    });
    loginAttemptService.clear.mockResolvedValue(undefined);
    challengePolicy.requireLoginCaptchaIfNeeded.mockResolvedValue(undefined);

    service = new PasswordSignInService(
      userService as never,
      sessionService as never,
      sessionAuditService as never,
      loginAttemptService as never,
      challengePolicy as never,
    );
  });

  it('normalizes the email and creates a session with the verified hash before clearing attempts', async () => {
    await expect(
      service.login(
        { email: ' USER@example.com ', password: 'correct-password' },
        request,
        response,
      ),
    ).resolves.toEqual(authenticatedUser);

    expect(userService.getUser).toHaveBeenCalledWith({
      email: 'user@example.com',
    });
    expect(userService.verifyPassword).toHaveBeenCalledWith(
      'correct-password',
      passwordHash,
    );
    expect(sessionService.createSession).toHaveBeenCalledWith(
      1,
      request,
      response,
      'LOGIN_SUCCESS',
      false,
      passwordHash,
    );
    expect(
      sessionService.createSession.mock.invocationCallOrder[0],
    ).toBeLessThan(loginAttemptService.clear.mock.invocationCallOrder[0]);
  });

  it('treats a password reset that wins the row-lock race as invalid credentials', async () => {
    sessionService.createSession.mockRejectedValueOnce(
      new SessionCredentialChangedError(),
    );

    await expect(
      service.login(
        { email: 'user@example.com', password: 'correct-password' },
        request,
        response,
      ),
    ).rejects.toMatchObject({
      response: {
        code: 'INVALID_CREDENTIALS',
        message: 'Invalid email or password',
      },
    });

    expect(loginAttemptService.clear).not.toHaveBeenCalled();
    expect(loginAttemptService.recordFailure).toHaveBeenCalledWith(
      'user@example.com',
      request,
    );
    expect(sessionAuditService.recordLoginFailed).toHaveBeenCalledWith(
      request,
      1,
    );
  });

  it('does not turn post-commit attempt cleanup failure into authentication failure', async () => {
    loginAttemptService.clear.mockRejectedValueOnce(
      new Error('redis unavailable'),
    );

    await expect(
      service.login(
        { email: 'user@example.com', password: 'correct-password' },
        request,
        response,
      ),
    ).resolves.toEqual(authenticatedUser);
  });

  it('runs the adaptive challenge before looking up credentials', async () => {
    challengePolicy.requireLoginCaptchaIfNeeded.mockRejectedValue(
      new BadRequestException({ code: 'CAPTCHA_REQUIRED', action: 'login' }),
    );

    await expect(
      service.login(
        { email: 'user@example.com', password: 'correct-password' },
        request,
        response,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(challengePolicy.requireLoginCaptchaIfNeeded).toHaveBeenCalledWith(
      'user@example.com',
      undefined,
      request,
    );
    expect(userService.getUser).not.toHaveBeenCalled();
  });

  it('asks for captcha on the failure that reaches the threshold', async () => {
    loginAttemptService.recordFailure.mockResolvedValue({
      pairAttempts: 3,
      ipAttempts: 3,
      captchaRequired: true,
    });
    challengePolicy.throwIfCaptchaRequiredAfterLoginFailure.mockImplementation(
      () => {
        throw new BadRequestException({
          code: 'CAPTCHA_REQUIRED',
          action: 'login',
        });
      },
    );

    await expect(
      service.login(
        { email: 'user@example.com', password: 'wrong-password' },
        request,
        response,
      ),
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        code: 'CAPTCHA_REQUIRED',
        action: 'login',
      }),
    });

    expect(sessionAuditService.recordLoginFailed).toHaveBeenCalled();
    expect(loginAttemptService.assertAllowed).toHaveBeenCalledTimes(2);
  });

  it('returns a login block before another challenge', async () => {
    loginAttemptService.assertAllowed.mockRejectedValueOnce(
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
      response: expect.objectContaining({ code: 'TOO_MANY_LOGIN_ATTEMPTS' }),
    });
    expect(challengePolicy.requireLoginCaptchaIfNeeded).not.toHaveBeenCalled();
  });

  it('does not clear failed-login state until email verification passes', async () => {
    userService.getUser.mockResolvedValue({
      ...authenticatedUser,
      emailVerified: false,
      password: passwordHash,
    });

    await expect(
      service.login(
        { email: 'user@example.com', password: 'correct-password' },
        request,
        response,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);

    expect(sessionAuditService.recordSecurityEvent).toHaveBeenCalledWith(
      'LOGIN_FAILED',
      request,
      1,
      { reason: 'email_not_verified' },
    );
    expect(loginAttemptService.clear).not.toHaveBeenCalled();
    expect(sessionService.createSession).not.toHaveBeenCalled();
  });

  it('checks the block state again after recording invalid credentials', async () => {
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
      response: expect.objectContaining({ code: 'TOO_MANY_LOGIN_ATTEMPTS' }),
    });
    expect(
      challengePolicy.throwIfCaptchaRequiredAfterLoginFailure,
    ).not.toHaveBeenCalled();
  });
});
