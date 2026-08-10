import { Logger, ServiceUnavailableException } from '@nestjs/common';
import {
  SecurityEmailPurpose,
  SendSecurityEmailResult,
} from '@pixaeron/notifications-contract';
import type { Request } from 'express';

import { AuthEmailDeliveryService } from './auth-email-delivery.service';

describe('AuthEmailDeliveryService', () => {
  const notificationsEmailClient = { sendSecurityEmail: jest.fn() };
  const emailActionAttemptService = { startCooldown: jest.fn() };
  const sessionAuditService = { recordSecurityEvent: jest.fn() };
  const configValues: Record<string, string> = {
    EMAIL_DELIVERY_ENABLED: 'true',
    EMAIL_ACTION_RESPONSE_BUDGET_MS: '2500',
  };
  const configService = {
    get: jest.fn((key: string) => configValues[key]),
  };
  const request = {} as Request;
  let service: AuthEmailDeliveryService;

  beforeAll(() => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterAll(() => {
    jest.restoreAllMocks();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    configValues.EMAIL_DELIVERY_ENABLED = 'true';
    emailActionAttemptService.startCooldown.mockResolvedValue(undefined);
    sessionAuditService.recordSecurityEvent.mockResolvedValue(undefined);
    notificationsEmailClient.sendSecurityEmail.mockResolvedValue({
      result: SendSecurityEmailResult.SEND_SECURITY_EMAIL_RESULT_ACCEPTED,
    });
    service = new AuthEmailDeliveryService(
      notificationsEmailClient as never,
      emailActionAttemptService as never,
      sessionAuditService as never,
      configService as never,
    );
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('retains the email delivery launch gate', () => {
    configValues.EMAIL_DELIVERY_ENABLED = 'false';
    service = new AuthEmailDeliveryService(
      notificationsEmailClient as never,
      emailActionAttemptService as never,
      sessionAuditService as never,
      configService as never,
    );

    expect(() => service.assertAvailable()).toThrow(
      ServiceUnavailableException,
    );
    expect(() => service.assertAvailable()).toThrow(
      expect.objectContaining({
        response: expect.objectContaining({
          code: 'EMAIL_DELIVERY_UNAVAILABLE',
        }),
      }),
    );
  });

  it('submits password reset details and records only sanitized acceptance metadata', async () => {
    await service.sendPasswordResetAfterCommit({
      userId: 1,
      publicSubject: '0198f687-15d8-7f5e-bd79-62f8f4d51e07',
      recipient: 'user@example.com',
      token: 'raw-reset-token',
      request,
    });

    const submittedRequest =
      notificationsEmailClient.sendSecurityEmail.mock.calls[0][0];
    expect(submittedRequest).toEqual({
      requestId: expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      ),
      publicSubject: '0198f687-15d8-7f5e-bd79-62f8f4d51e07',
      recipient: 'user@example.com',
      purpose: SecurityEmailPurpose.SECURITY_EMAIL_PURPOSE_PASSWORD_RESET,
      token: 'raw-reset-token',
      contentVersion: 1,
    });
    expect(sessionAuditService.recordSecurityEvent).toHaveBeenCalledWith(
      'PASSWORD_RESET_ACCEPTED',
      request,
      1,
      {
        requestId: submittedRequest.requestId,
        outcome: 'ACCEPTED',
      },
    );
  });

  it.each([
    [SendSecurityEmailResult.SEND_SECURITY_EMAIL_RESULT_FAILED, 'FAILED'],
    [SendSecurityEmailResult.SEND_SECURITY_EMAIL_RESULT_REJECTED, 'REJECTED'],
    [
      SendSecurityEmailResult.SEND_SECURITY_EMAIL_RESULT_SUPPRESSED,
      'SUPPRESSED',
    ],
    [
      SendSecurityEmailResult.SEND_SECURITY_EMAIL_RESULT_SUBMISSION_UNKNOWN,
      'SUBMISSION_UNKNOWN',
    ],
  ])(
    'maps non-accepted result %s to the existing failure audit',
    async (result, outcome) => {
      notificationsEmailClient.sendSecurityEmail.mockResolvedValue({
        result,
        code: 'not-audited-provider-detail',
      });

      await service.sendEmailVerificationAfterCommit(
        {
          userId: 2,
          publicSubject: '0198f687-15d8-7f5e-bd79-62f8f4d51e08',
          recipient: 'new@example.com',
          token: 'verification-token',
          request,
        },
        false,
      );

      const submittedRequest =
        notificationsEmailClient.sendSecurityEmail.mock.calls[0][0];
      expect(sessionAuditService.recordSecurityEvent).toHaveBeenCalledWith(
        'EMAIL_VERIFICATION_FAILED',
        request,
        2,
        { requestId: submittedRequest.requestId, outcome },
      );
    },
  );

  it('treats an RPC error as submission unknown without exposing it', async () => {
    notificationsEmailClient.sendSecurityEmail.mockRejectedValue(
      new Error('private gRPC failure'),
    );

    await expect(
      service.sendPasswordResetAfterCommit({
        userId: 1,
        publicSubject: '0198f687-15d8-7f5e-bd79-62f8f4d51e07',
        recipient: 'user@example.com',
        token: 'raw-reset-token',
        request,
      }),
    ).resolves.toBeUndefined();

    const submittedRequest =
      notificationsEmailClient.sendSecurityEmail.mock.calls[0][0];
    expect(sessionAuditService.recordSecurityEvent).toHaveBeenCalledWith(
      'PASSWORD_RESET_FAILED',
      request,
      1,
      {
        requestId: submittedRequest.requestId,
        outcome: 'SUBMISSION_UNKNOWN',
      },
    );
  });

  it('continues delivery when post-registration cooldown setup fails', async () => {
    emailActionAttemptService.startCooldown.mockRejectedValue(
      new Error('redis unavailable'),
    );

    await service.sendEmailVerificationAfterCommit(
      {
        userId: 2,
        publicSubject: '0198f687-15d8-7f5e-bd79-62f8f4d51e08',
        recipient: 'new@example.com',
        token: 'verification-token',
        request,
      },
      true,
    );

    expect(notificationsEmailClient.sendSecurityEmail).toHaveBeenCalledTimes(1);
  });

  it('does not turn an acceptance audit failure into a delivery failure', async () => {
    sessionAuditService.recordSecurityEvent.mockRejectedValue(
      new Error('audit unavailable'),
    );

    await expect(
      service.sendEmailVerificationAfterCommit(
        {
          userId: 2,
          publicSubject: '0198f687-15d8-7f5e-bd79-62f8f4d51e08',
          recipient: 'new@example.com',
          token: 'verification-token',
          request,
        },
        false,
      ),
    ).resolves.toBeUndefined();

    expect(sessionAuditService.recordSecurityEvent).toHaveBeenCalledTimes(1);
    expect(sessionAuditService.recordSecurityEvent).toHaveBeenCalledWith(
      'EMAIL_VERIFICATION_ACCEPTED',
      request,
      2,
      expect.objectContaining({ outcome: 'ACCEPTED' }),
    );
  });

  it('keeps an ordinary generic action pending until the response budget', async () => {
    jest.useFakeTimers();
    const action = jest.fn().mockResolvedValue(undefined);
    let settled = false;

    const completion = service.runGenericEmailAction(action).then(() => {
      settled = true;
    });
    await Promise.resolve();

    await jest.advanceTimersByTimeAsync(2_499);
    expect(settled).toBe(false);

    await jest.advanceTimersByTimeAsync(1);
    await completion;
    expect(settled).toBe(true);
  });

  it('keeps an outage branch pending until the same response budget', async () => {
    jest.useFakeTimers();
    const outage = new Error('dependency outage');
    let settled = false;

    const completion = service.runGenericEmailAction(async () => {
      throw outage;
    });
    void completion.catch(() => {
      settled = true;
    });
    await Promise.resolve();

    await jest.advanceTimersByTimeAsync(2_499);
    expect(settled).toBe(false);

    await jest.advanceTimersByTimeAsync(1);
    await expect(completion).rejects.toBe(outage);
    expect(settled).toBe(true);
  });
});
