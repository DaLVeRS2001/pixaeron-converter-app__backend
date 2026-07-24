import { HttpStatus } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { Request } from 'express';

import type { SessionMetadataService } from '../session/services/session-metadata.service';
import { LoginAttemptService } from './login-attempt.service';

describe('LoginAttemptService', () => {
  const redis = {
    pTTL: jest.fn(),
    get: jest.fn(),
    eval: jest.fn(),
    del: jest.fn(),
  };
  const configService = {
    getOrThrow: jest.fn().mockReturnValue('test-hash-secret'),
  };
  const sessionMetadataService = {
    getFromRequest: jest.fn().mockReturnValue({ ipHash: 'request-ip-hash' }),
  };
  const request = {} as Request;
  const service = new LoginAttemptService(
    redis as never,
    configService as unknown as ConfigService,
    sessionMetadataService as unknown as SessionMetadataService,
  );

  beforeEach(() => jest.clearAllMocks());

  it('rejects a login while the block key is active', async () => {
    redis.pTTL.mockResolvedValueOnce(30_000).mockResolvedValueOnce(-2);

    await expect(
      service.assertAllowed('user@example.com', request),
    ).rejects.toMatchObject({
      status: HttpStatus.TOO_MANY_REQUESTS,
    });
  });

  it('records a failure atomically with expiry and block arguments', async () => {
    redis.eval.mockResolvedValue([1, 1]);

    await expect(
      service.recordFailure('user@example.com', request),
    ).resolves.toEqual({
      pairAttempts: 1,
      ipAttempts: 1,
      captchaRequired: false,
    });

    expect(redis.eval).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        keys: [
          expect.stringMatching(/^auth:login:pair:attempts:request-ip-hash:/),
          expect.stringMatching(/^auth:login:ip:attempts:/),
          expect.stringMatching(/^auth:login:pair:block:request-ip-hash:/),
          expect.stringMatching(/^auth:login:ip:block:/),
        ],
        arguments: ['900000', '5', '25', '900000'],
      }),
    );
  });

  it('requires captcha after three pair failures', async () => {
    redis.get.mockResolvedValue('3');

    await expect(
      service.isCaptchaRequired('user@example.com', request),
    ).resolves.toBe(true);
  });

  it('returns a stable block code and retry delay', async () => {
    redis.pTTL.mockResolvedValueOnce(30_001).mockResolvedValueOnce(-2);

    await expect(
      service.assertAllowed('user@example.com', request),
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        code: 'TOO_MANY_LOGIN_ATTEMPTS',
        retryAfter: 31,
      }),
    });
  });

  it('clears only the IP and email pair after a successful login', async () => {
    await service.clear('user@example.com', request);

    expect(redis.del).toHaveBeenCalledWith([
      expect.stringMatching(/^auth:login:pair:attempts:request-ip-hash:/),
      expect.stringMatching(/^auth:login:pair:block:request-ip-hash:/),
    ]);
  });

  it('uses a separate pair key for the same email from another IP', async () => {
    redis.eval.mockResolvedValue([1, 1]);
    sessionMetadataService.getFromRequest
      .mockReturnValueOnce({ ipHash: 'first-ip' })
      .mockReturnValueOnce({ ipHash: 'second-ip' });

    await service.recordFailure('user@example.com', request);
    await service.recordFailure('user@example.com', request);

    expect(redis.eval.mock.calls[0][1].keys[0]).toContain('first-ip');
    expect(redis.eval.mock.calls[1][1].keys[0]).toContain('second-ip');
  });
});
