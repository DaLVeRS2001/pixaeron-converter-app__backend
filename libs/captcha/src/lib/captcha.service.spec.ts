import {
  BadRequestException,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import axios from 'axios';

import { CaptchaRequest, CaptchaService } from './captcha.service';

jest.mock('axios');

describe('CaptchaService', () => {
  const config = new Map<string, string>([
    ['CAPTCHA_ENABLED', 'true'],
    ['CAPTCHA_SECRET_KEY', 'test-secret'],
    ['CAPTCHA_HOSTNAME', 'pixaeron.com'],
  ]);
  const configService = {
    get: jest.fn((key: string) => config.get(key)),
    getOrThrow: jest.fn((key: string) => {
      const value = config.get(key);
      if (value === undefined) throw new Error(`Missing ${key}`);
      return value;
    }),
  };
  const request = {
    ip: '203.0.113.10',
    socket: {},
  } satisfies CaptchaRequest;
  const service = new CaptchaService(configService as unknown as ConfigService);
  const mockedAxios = jest.mocked(axios);

  beforeEach(() => {
    jest.clearAllMocks();
    config.set('CAPTCHA_ENABLED', 'true');
    config.set('CAPTCHA_HOSTNAME', 'pixaeron.com');
  });

  it('does not call Cloudflare when captcha is disabled', async () => {
    config.set('CAPTCHA_ENABLED', 'false');

    await service.verify('token', request, 'login');

    expect(mockedAxios.post).not.toHaveBeenCalled();
  });

  it('accepts a valid token for the expected action and hostname', async () => {
    mockedAxios.post.mockResolvedValue({
      data: {
        success: true,
        action: 'login',
        hostname: 'pixaeron.com',
      },
    });

    await expect(service.verify('token', request, 'login')).resolves.toBe(
      undefined,
    );
    expect(mockedAxios.post).toHaveBeenCalledWith(
      'https://challenges.cloudflare.com/turnstile/v0/siteverify',
      expect.any(URLSearchParams),
      expect.objectContaining({ timeout: 5_000 }),
    );
  });

  it('rejects a token issued for another action', async () => {
    mockedAxios.post.mockResolvedValue({
      data: {
        success: true,
        action: 'register',
        hostname: 'pixaeron.com',
      },
    });

    await expect(
      service.verify('token', request, 'login'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a token issued for another hostname', async () => {
    mockedAxios.post.mockResolvedValue({
      data: {
        success: true,
        action: 'login',
        hostname: 'attacker.example',
      },
    });

    await expect(
      service.verify('token', request, 'login'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('fails closed when Siteverify is unavailable', async () => {
    mockedAxios.post.mockRejectedValue(new Error('network unavailable'));

    await expect(
      service.verify('token', request, 'login'),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});
