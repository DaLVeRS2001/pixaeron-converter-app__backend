import { SESv2Client } from '@aws-sdk/client-sesv2';
import { ServiceUnavailableException } from '@nestjs/common';

import { TransactionalEmailService } from './transactional-email.service';

describe('TransactionalEmailService', () => {
  afterEach(() => jest.restoreAllMocks());

  it('returns a stable launch-gate error when delivery is disabled', () => {
    const configService = {
      get: jest.fn().mockReturnValue('false'),
      getOrThrow: jest.fn(),
    };
    const service = new TransactionalEmailService(configService as never);

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
    expect(configService.getOrThrow).not.toHaveBeenCalled();
  });

  it('validates all required email settings during startup when enabled', () => {
    const configService = {
      get: jest.fn().mockReturnValue('true'),
      getOrThrow: jest.fn((key: string) => {
        if (key === 'AWS_REGION') return 'eu-central-1';
        throw new Error(`Missing ${key}`);
      }),
    };

    expect(() => new TransactionalEmailService(configService as never)).toThrow(
      'Missing FRONTEND_URL',
    );
  });

  it('returns the SES message ID as an accepted-delivery receipt', async () => {
    jest
      .spyOn(SESv2Client.prototype, 'send')
      .mockResolvedValue({ MessageId: 'ses-message-id' } as never);
    const values: Record<string, string> = {
      AWS_REGION: 'eu-central-1',
      FRONTEND_URL: 'https://pixaeron.com/',
      SES_FROM_EMAIL: 'Pixaeron <no-reply@pixaeron.com>',
    };
    const configService = {
      get: jest.fn().mockReturnValue('true'),
      getOrThrow: jest.fn((key: string) => values[key]),
    };
    const service = new TransactionalEmailService(configService as never);

    await expect(
      service.sendEmailVerification('user@example.com', 'raw-token'),
    ).resolves.toEqual({ provider: 'ses', messageId: 'ses-message-id' });
  });
});
