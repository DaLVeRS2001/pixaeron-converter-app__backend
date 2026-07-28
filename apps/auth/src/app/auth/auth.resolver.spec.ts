import type { Request, Response } from 'express';

import { PlanCode } from '../../generated/prisma/client';
import type { AuthenticatedUser } from '../user/prisma/user.select';

import { AuthResolver } from './auth.resolver';

describe('AuthResolver delegation', () => {
  const passwordSignInService = { login: jest.fn() };
  const registrationService = {
    register: jest.fn(),
    resendEmailVerification: jest.fn(),
    verifyEmail: jest.fn(),
  };
  const passwordRecoveryService = {
    requestPasswordReset: jest.fn(),
    resetPassword: jest.fn(),
  };
  const googleSignInService = { login: jest.fn() };
  const sessionService = { logout: jest.fn(), logoutAll: jest.fn() };
  const resolver = new AuthResolver(
    passwordSignInService as never,
    registrationService as never,
    passwordRecoveryService as never,
    googleSignInService as never,
    sessionService as never,
  );
  const request = {
    user: {
      id: 7,
      publicId: '0198f687-15d8-7f5e-bd79-62f8f4d51e07',
      email: 'user@example.com',
      username: 'user',
      emailVerified: true,
      planCode: PlanCode.FREE,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    },
  } as unknown as Request & { user: AuthenticatedUser };
  const response = {} as Response;
  const context = { req: request, res: response };

  beforeEach(() => jest.clearAllMocks());

  it('delegates credential and Google sign-in with the complete HTTP context', async () => {
    const loginInput = {
      email: 'user@example.com',
      password: 'Strong-password-123!',
      rememberMe: true,
    };
    const googleLoginInput = {
      idToken: 'google-id-token',
      rememberMe: true,
    };
    passwordSignInService.login.mockResolvedValue({ id: 7 });
    googleSignInService.login.mockResolvedValue({ id: 8 });

    await expect(resolver.login(loginInput, context)).resolves.toEqual({
      id: 7,
    });
    await expect(
      resolver.googleLogin(googleLoginInput, context),
    ).resolves.toEqual({ id: 8 });

    expect(passwordSignInService.login).toHaveBeenCalledWith(
      loginInput,
      request,
      response,
    );
    expect(googleSignInService.login).toHaveBeenCalledWith(
      googleLoginInput,
      request,
      response,
    );
  });

  it('delegates registration and verification operations without a response dependency', async () => {
    const registerInput = {
      email: 'new@example.com',
      username: 'new-user',
      password: 'Strong-password-123!',
    };
    const emailInput = { email: 'new@example.com' };
    const tokenInput = { token: 'verification-token' };
    registrationService.register.mockResolvedValue({ accepted: true });
    registrationService.resendEmailVerification.mockResolvedValue({
      accepted: true,
    });
    registrationService.verifyEmail.mockResolvedValue({ status: 'VERIFIED' });

    await resolver.register(registerInput, request);
    await resolver.resendEmailVerification(emailInput, request);
    await resolver.verifyEmail(tokenInput, request);

    expect(registrationService.register).toHaveBeenCalledWith(
      registerInput,
      request,
    );
    expect(registrationService.resendEmailVerification).toHaveBeenCalledWith(
      emailInput,
      request,
    );
    expect(registrationService.verifyEmail).toHaveBeenCalledWith(
      tokenInput,
      request,
    );
  });

  it('delegates password recovery and supplies the response only for cookie cleanup', async () => {
    const emailInput = { email: 'user@example.com' };
    const resetInput = {
      token: 'password-reset-token',
      password: 'Replacement-password-123!',
    };
    passwordRecoveryService.requestPasswordReset.mockResolvedValue({
      accepted: true,
    });
    passwordRecoveryService.resetPassword.mockResolvedValue({
      status: 'RESET',
    });

    await resolver.requestPasswordReset(emailInput, request);
    await resolver.resetPassword(resetInput, context);

    expect(passwordRecoveryService.requestPasswordReset).toHaveBeenCalledWith(
      emailInput,
      request,
    );
    expect(passwordRecoveryService.resetPassword).toHaveBeenCalledWith(
      resetInput,
      request,
      response,
    );
  });

  it('delegates both session exit paths to SessionService', async () => {
    sessionService.logout.mockResolvedValue(true);
    sessionService.logoutAll.mockResolvedValue(true);

    await expect(resolver.logout(context)).resolves.toBe(true);
    await expect(resolver.logoutAll(request, response)).resolves.toBe(true);

    expect(sessionService.logout).toHaveBeenCalledWith(request, response);
    expect(sessionService.logoutAll).toHaveBeenCalledWith(7, request, response);
  });
});
