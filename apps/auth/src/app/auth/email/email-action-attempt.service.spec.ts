import { HttpException } from '@nestjs/common';
import type { Request } from 'express';

import { EmailActionAttemptService } from './email-action-attempt.service';

describe('EmailActionAttemptService', () => {
  const redis = {
    eval: jest.fn(),
    get: jest.fn(),
    pTTL: jest.fn(),
    set: jest.fn(),
  };
  const configService = {
    getOrThrow: jest.fn().mockReturnValue('test-hmac-secret'),
  };
  const sessionMetadataService = {
    getFromRequest: jest.fn().mockReturnValue({
      ipHash: 'ip-hmac',
      userAgent: null,
    }),
  };
  const request = {} as Request;
  const service = new EmailActionAttemptService(
    redis as never,
    configService as never,
    sessionMetadataService as never,
  );

  beforeEach(() => jest.clearAllMocks());

  it('requires captcha after two previous requests', async () => {
    redis.get.mockResolvedValueOnce('1').mockResolvedValueOnce('2');

    await expect(
      service.isCaptchaRequired('forgot_password', 'user@example.com', request),
    ).resolves.toBe(false);
    await expect(
      service.isCaptchaRequired('forgot_password', 'user@example.com', request),
    ).resolves.toBe(true);
  });

  it('returns retryAfter for an active block', async () => {
    redis.pTTL.mockResolvedValueOnce(60_001).mockResolvedValueOnce(-2);

    const result = service.assertAllowed(
      'resend_confirmation',
      'user@example.com',
      request,
    );

    await expect(result).rejects.toBeInstanceOf(HttpException);
    await expect(result).rejects.toMatchObject({
      response: expect.objectContaining({
        code: 'TOO_MANY_AUTH_ATTEMPTS',
        action: 'resend_confirmation',
        retryAfter: 61,
      }),
    });
  });

  it('returns the dedicated cooldown error before another email is reserved', async () => {
    redis.pTTL.mockResolvedValueOnce(-2).mockResolvedValueOnce(45_001);

    await expect(
      service.assertAllowed('resend_confirmation', 'user@example.com', request),
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        code: 'AUTH_ACTION_COOLDOWN',
        retryAfter: 46,
      }),
    });
  });

  it('reserves attempts atomically under HMAC-only keys', async () => {
    redis.eval.mockResolvedValue([2, 1]);

    await service.reserve('forgot_password', 'user@example.com', request);

    const options = redis.eval.mock.calls[0]?.[1] as {
      keys: string[];
      arguments: string[];
    };
    expect(options.keys).toHaveLength(3);
    expect(options.keys.join(':')).toContain('ip-hmac');
    expect(options.keys.join(':')).not.toContain('user@example.com');
    expect(options.keys[2]).not.toContain('ip-hmac');
    expect(options.arguments).toEqual(['900000', '5', '900000', '60000']);
  });

  it('allows only one of two concurrent reservations during the cooldown', async () => {
    let reserved = false;
    redis.eval.mockImplementation(async () => {
      if (reserved) return [1, 60_000];
      reserved = true;
      return [2, 1];
    });

    const results = await Promise.allSettled([
      service.reserve('forgot_password', 'user@example.com', request),
      service.reserve('forgot_password', 'user@example.com', request),
    ]);

    expect(results.filter(({ status }) => status === 'fulfilled')).toHaveLength(
      1,
    );
    expect(results.filter(({ status }) => status === 'rejected')).toHaveLength(
      1,
    );
  });

  it('starts the resend cooldown without extending an existing cooldown', async () => {
    redis.set.mockResolvedValue('OK');

    await service.startCooldown(
      'resend_confirmation',
      'user@example.com',
      request,
    );

    expect(redis.set).toHaveBeenCalledWith(
      expect.stringContaining(':cooldown'),
      '1',
      {
        PX: 60_000,
        NX: true,
      },
    );
  });
});
