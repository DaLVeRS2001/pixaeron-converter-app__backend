import { Logger } from '@nestjs/common';
import type { Request } from 'express';

import { AuthEmailDeliveryService } from './auth-email-delivery.service';

describe('AuthEmailDeliveryService', () => {
  const transactionalEmailService = {
    assertAvailable: jest.fn(),
    sendEmailVerification: jest.fn(),
    sendPasswordReset: jest.fn(),
  };
  const emailActionAttemptService = { startCooldown: jest.fn() };
  const sessionAuditService = { recordSecurityEvent: jest.fn() };
  const request = {} as Request;
  const service = new AuthEmailDeliveryService(
    transactionalEmailService as never,
    emailActionAttemptService as never,
    sessionAuditService as never,
  );

  beforeAll(() => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterAll(() => {
    jest.restoreAllMocks();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    emailActionAttemptService.startCooldown.mockResolvedValue(undefined);
    sessionAuditService.recordSecurityEvent.mockResolvedValue(undefined);
    transactionalEmailService.sendEmailVerification.mockResolvedValue({
      provider: 'ses',
      messageId: 'verification-message-id',
    });
    transactionalEmailService.sendPasswordReset.mockResolvedValue({
      provider: 'ses',
      messageId: 'reset-message-id',
    });
  });

  it('delegates delivery availability without hiding failures', () => {
    transactionalEmailService.assertAvailable.mockImplementation(() => {
      throw new Error('disabled');
    });

    expect(() => service.assertAvailable()).toThrow('disabled');
  });

  it('records SES acceptance with the provider message ID, not as delivery', async () => {
    await service.sendPasswordResetAfterCommit(
      1,
      'user@example.com',
      'raw-reset-token',
      request,
    );

    expect(sessionAuditService.recordSecurityEvent).toHaveBeenCalledWith(
      'PASSWORD_RESET_ACCEPTED',
      request,
      1,
      { provider: 'ses', providerMessageId: 'reset-message-id' },
    );
  });

  it('records email verification delivery failure after commit without throwing', async () => {
    transactionalEmailService.sendEmailVerification.mockRejectedValue(
      new Error('ses unavailable'),
    );

    await expect(
      service.sendEmailVerificationAfterCommit(
        2,
        'new@example.com',
        'verification-token',
        request,
        true,
      ),
    ).resolves.toBeUndefined();

    expect(emailActionAttemptService.startCooldown).toHaveBeenCalledWith(
      'resend_confirmation',
      'new@example.com',
      request,
    );
    expect(sessionAuditService.recordSecurityEvent).toHaveBeenCalledWith(
      'EMAIL_VERIFICATION_FAILED',
      request,
      2,
      { reason: 'delivery_failed' },
    );
  });

  it('continues delivery when post-registration cooldown setup fails', async () => {
    emailActionAttemptService.startCooldown.mockRejectedValue(
      new Error('redis unavailable'),
    );

    await service.sendEmailVerificationAfterCommit(
      2,
      'new@example.com',
      'verification-token',
      request,
      true,
    );

    expect(
      transactionalEmailService.sendEmailVerification,
    ).toHaveBeenCalledWith('new@example.com', 'verification-token');
  });

  it.each([
    {
      accepted: 'EMAIL_VERIFICATION_ACCEPTED',
      failed: 'EMAIL_VERIFICATION_FAILED',
      send: () =>
        service.sendEmailVerificationAfterCommit(
          2,
          'new@example.com',
          'verification-token',
          request,
          false,
        ),
    },
    {
      accepted: 'PASSWORD_RESET_ACCEPTED',
      failed: 'PASSWORD_RESET_FAILED',
      send: () =>
        service.sendPasswordResetAfterCommit(
          1,
          'user@example.com',
          'reset-token',
          request,
        ),
    },
  ])(
    'does not turn $accepted audit failure into $failed',
    async ({ accepted, failed, send }) => {
      sessionAuditService.recordSecurityEvent.mockImplementation(
        async (type) => {
          if (type === accepted) throw new Error('audit unavailable');
        },
      );

      await expect(send()).resolves.toBeUndefined();
      expect(sessionAuditService.recordSecurityEvent).not.toHaveBeenCalledWith(
        failed,
        request,
        expect.any(Number),
        { reason: 'delivery_failed' },
      );
    },
  );
});
