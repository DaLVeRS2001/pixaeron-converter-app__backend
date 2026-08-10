import {
  BadRequestException,
  GetAccountCommand,
  GetConfigurationSetCommand,
  GetConfigurationSetEventDestinationsCommand,
  GetEmailIdentityCommand,
  MessageRejected,
  SendEmailCommand,
  SESv2Client,
  SESv2ServiceException,
} from '@aws-sdk/client-sesv2';
import { ConfigService } from '@nestjs/config';

import { SesEmailService } from './ses-email.service';

const content = {
  subject: 'Subject',
  text: 'Plain text',
  html: '<p>HTML</p>',
};

const readyAccount = {
  ProductionAccessEnabled: true,
  SendingEnabled: true,
  EnforcementStatus: 'HEALTHY',
  SuppressionAttributes: { SuppressedReasons: ['BOUNCE', 'COMPLAINT'] },
  $metadata: {},
};
const readyIdentity = {
  VerifiedForSendingStatus: true,
  VerificationStatus: 'SUCCESS',
  DkimAttributes: { SigningEnabled: true, Status: 'SUCCESS' },
  MailFromAttributes: {
    MailFromDomain: 'bounce.pixaeron.com',
    MailFromDomainStatus: 'SUCCESS',
    BehaviorOnMxFailure: 'USE_DEFAULT_VALUE',
  },
  $metadata: {},
};
const readyConfigurationSet = {
  SendingOptions: { SendingEnabled: true },
  $metadata: {},
};
const readyDestinations = {
  EventDestinations: [
    {
      Name: 'feedback',
      Enabled: true,
      MatchingEventTypes: [
        'BOUNCE',
        'COMPLAINT',
        'DELIVERY',
        'DELIVERY_DELAY',
        'REJECT',
        'RENDERING_FAILURE',
        'SEND',
      ],
      SnsDestination: {
        TopicArn: 'arn:aws:sns:eu-central-1:123456789012:pixaeron-feedback',
      },
    },
  ],
  $metadata: {},
};

describe('SesEmailService', () => {
  it('skips provider preflight outside production', async () => {
    const send = jest.fn();
    const service = createService(send);

    await service.onModuleInit();

    expect(send).not.toHaveBeenCalled();
  });

  it('verifies the production SES account, identity, configuration set, and SNS destination', async () => {
    const send = createReadyPreflight();
    const service = createService(send, { NODE_ENV: 'production' });

    await service.onModuleInit();

    expect(send).toHaveBeenCalledTimes(4);
    expect(send.mock.calls[0][0]).toBeInstanceOf(GetAccountCommand);
    expect((send.mock.calls[1][0] as GetEmailIdentityCommand).input).toEqual({
      EmailIdentity: 'pixaeron.com',
    });
    expect((send.mock.calls[2][0] as GetConfigurationSetCommand).input).toEqual(
      { ConfigurationSetName: 'pixaeron-transactional' },
    );
    expect(
      (send.mock.calls[3][0] as GetConfigurationSetEventDestinationsCommand)
        .input,
    ).toEqual({ ConfigurationSetName: 'pixaeron-transactional' });
  });

  it('rejects production startup without bounce and complaint account suppression', async () => {
    const send = createReadyPreflight({
      account: {
        ...readyAccount,
        SuppressionAttributes: { SuppressedReasons: ['BOUNCE'] },
      },
    });
    const service = createService(send, { NODE_ENV: 'production' });

    await expect(service.onModuleInit()).rejects.toThrow(
      'SES account suppression must include bounce and complaint',
    );
  });

  it('rejects production startup when the source identity is not ready', async () => {
    const send = createReadyPreflight({
      identity: {
        ...readyIdentity,
        DkimAttributes: { SigningEnabled: true, Status: 'PENDING' },
      },
    });
    const service = createService(send, { NODE_ENV: 'production' });

    await expect(service.onModuleInit()).rejects.toThrow(
      'SES source identity is not production-ready',
    );
  });

  it('rejects production startup without the complete SNS feedback destination', async () => {
    const send = createReadyPreflight({
      destinations: {
        EventDestinations: [
          {
            ...readyDestinations.EventDestinations[0],
            MatchingEventTypes: ['BOUNCE', 'COMPLAINT'],
          },
        ],
        $metadata: {},
      },
    });
    const service = createService(send, { NODE_ENV: 'production' });

    await expect(service.onModuleInit()).rejects.toThrow(
      'SES feedback SNS destination is incomplete or disabled',
    );
  });

  it('sanitizes provider failures during production preflight', async () => {
    const send = jest.fn().mockRejectedValue(new Error('raw provider detail'));
    const service = createService(send, { NODE_ENV: 'production' });

    await expect(service.onModuleInit()).rejects.toThrow(
      'SES production preflight request failed',
    );
    await expect(service.onModuleInit()).rejects.not.toThrow(
      'raw provider detail',
    );
  });

  it('submits one single-recipient message with the configuration set and request tag', async () => {
    const send = jest.fn().mockResolvedValue({
      MessageId: 'message-1',
      $metadata: {},
    });
    const service = createService(send);

    await expect(
      service.submit('user@example.com', 'request-id', content),
    ).resolves.toEqual({
      status: 'ACCEPTED',
      messageId: 'message-1',
    });

    expect(send).toHaveBeenCalledTimes(1);
    const input = (send.mock.calls[0][0] as SendEmailCommand).input;
    expect(input.Destination).toEqual({
      ToAddresses: ['user@example.com'],
    });
    expect(input.ConfigurationSetName).toBe('pixaeron-transactional');
    expect(input.EmailTags).toEqual([
      { Name: 'request-id', Value: 'request-id' },
    ]);
  });

  it('limits the SES request to the remaining caller deadline budget', async () => {
    const send = jest.fn().mockResolvedValue({
      MessageId: 'message-1',
      $metadata: {},
    });
    const timeout = jest.spyOn(AbortSignal, 'timeout');
    const service = createService(send);
    try {
      await service.submit('user@example.com', 'request-id', content, 250);
      expect(timeout).toHaveBeenLastCalledWith(250);
    } finally {
      timeout.mockRestore();
    }
  });
  it.each([0, -1])(
    'rejects a non-positive caller deadline budget of %s before calling SES',
    async (remainingBudgetMs) => {
      const send = jest.fn();
      const service = createService(send);

      await expect(
        service.submit(
          'user@example.com',
          'request-id',
          content,
          remainingBudgetMs,
        ),
      ).resolves.toEqual({
        status: 'FAILED',
        code: 'CALLER_DEADLINE_EXCEEDED',
      });

      expect(send).not.toHaveBeenCalled();
    },
  );
  it('treats a successful response without MessageId as ambiguous', async () => {
    const send = jest.fn().mockResolvedValue({ $metadata: {} });
    const service = createService(send);

    await expect(
      service.submit('user@example.com', 'request-id', content),
    ).resolves.toEqual({
      status: 'SUBMISSION_UNKNOWN',
      code: 'SES_MESSAGE_ID_MISSING',
    });
  });

  it('classifies a documented message rejection as known rejection', async () => {
    const send = jest.fn().mockRejectedValue(
      new MessageRejected({
        message: 'rejected',
        $metadata: {},
      }),
    );
    const service = createService(send);

    await expect(
      service.submit('user@example.com', 'request-id', content),
    ).resolves.toEqual({
      status: 'REJECTED',
      code: 'SES_MESSAGE_REJECTED',
    });
  });

  it('classifies an explicit pre-acceptance provider failure', async () => {
    const send = jest.fn().mockRejectedValue(
      new BadRequestException({
        message: 'invalid request',
        $metadata: { httpStatusCode: 400 },
      }),
    );
    const service = createService(send);

    await expect(
      service.submit('user@example.com', 'request-id', content),
    ).resolves.toEqual({
      status: 'FAILED',
      code: 'SES_BAD_REQUEST',
    });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('classifies credential resolution failure before the request as known failure', async () => {
    const credentialsError = new Error('credentials missing');
    credentialsError.name = 'CredentialsProviderError';
    const send = jest.fn().mockRejectedValue(credentialsError);
    const service = createService(send);

    await expect(
      service.submit('user@example.com', 'request-id', content),
    ).resolves.toEqual({
      status: 'FAILED',
      code: 'SES_CREDENTIALS_UNAVAILABLE',
    });
  });

  it.each([
    ['AccessDeniedException', 'SES_ACCESS_DENIED'],
    ['ExpiredTokenException', 'SES_EXPIRED_TOKEN'],
    ['UnrecognizedClientException', 'SES_UNRECOGNIZED_CLIENT'],
  ])(
    'classifies the %s credential response as a known failure',
    async (name, code) => {
      const send = jest.fn().mockRejectedValue(
        new SESv2ServiceException({
          name,
          $fault: 'client',
          $metadata: { httpStatusCode: 403 },
        }),
      );
      const service = createService(send);

      await expect(
        service.submit('user@example.com', 'request-id', content),
      ).resolves.toEqual({ status: 'FAILED', code });
    },
  );

  it('classifies an unmapped provider 4xx response as a known failure', async () => {
    const send = jest.fn().mockRejectedValue(
      new SESv2ServiceException({
        name: 'ValidationError',
        $fault: 'client',
        $metadata: { httpStatusCode: 400 },
      }),
    );
    const service = createService(send);

    await expect(
      service.submit('user@example.com', 'request-id', content),
    ).resolves.toEqual({
      status: 'FAILED',
      code: 'SES_CLIENT_ERROR',
    });
  });

  it.each([
    ['RequestAbortedException', 400],
    ['InternalFailure', 500],
  ])(
    'keeps %s ambiguous because SES acceptance is unknown',
    async (name, httpStatusCode) => {
      const send = jest.fn().mockRejectedValue(
        new SESv2ServiceException({
          name,
          $fault: httpStatusCode >= 500 ? 'server' : 'client',
          $metadata: { httpStatusCode },
        }),
      );
      const service = createService(send);

      await expect(
        service.submit('user@example.com', 'request-id', content),
      ).resolves.toEqual({
        status: 'SUBMISSION_UNKNOWN',
        code: 'SES_SUBMISSION_UNKNOWN',
      });
    },
  );

  it('treats RequestTimeout as ambiguous even though AWS marks it as a client fault', async () => {
    const send = jest.fn().mockRejectedValue(
      new SESv2ServiceException({
        name: 'RequestTimeout',
        $fault: 'client',
        $metadata: { httpStatusCode: 400 },
      }),
    );
    const service = createService(send);

    await expect(
      service.submit('user@example.com', 'request-id', content),
    ).resolves.toEqual({
      status: 'SUBMISSION_UNKNOWN',
      code: 'SES_SUBMISSION_UNKNOWN',
    });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('does not retry an ambiguous transport failure', async () => {
    const send = jest.fn().mockRejectedValue(new Error('socket closed'));
    const service = createService(send);

    await expect(
      service.submit('user@example.com', 'request-id', content),
    ).resolves.toEqual({
      status: 'SUBMISSION_UNKNOWN',
      code: 'SES_SUBMISSION_UNKNOWN',
    });
    expect(send).toHaveBeenCalledTimes(1);
  });
});

function createReadyPreflight(overrides?: {
  account?: Record<string, unknown>;
  identity?: Record<string, unknown>;
  configurationSet?: Record<string, unknown>;
  destinations?: Record<string, unknown>;
}): jest.Mock {
  return jest.fn().mockImplementation((command: unknown) => {
    if (command instanceof GetAccountCommand) {
      return Promise.resolve(overrides?.account ?? readyAccount);
    }
    if (command instanceof GetEmailIdentityCommand) {
      return Promise.resolve(overrides?.identity ?? readyIdentity);
    }
    if (command instanceof GetConfigurationSetCommand) {
      return Promise.resolve(
        overrides?.configurationSet ?? readyConfigurationSet,
      );
    }
    if (command instanceof GetConfigurationSetEventDestinationsCommand) {
      return Promise.resolve(overrides?.destinations ?? readyDestinations);
    }
    throw new Error('Unexpected SES command');
  });
}

function createService(
  send: jest.Mock,
  overrides: Record<string, string> = {},
): SesEmailService {
  const config = new ConfigService({
    NODE_ENV: 'test',
    AWS_REGION: 'eu-central-1',
    SES_CONFIGURATION_SET: 'pixaeron-transactional',
    SES_EXPECTED_SOURCE_ARN:
      'arn:aws:ses:eu-central-1:123456789012:identity/pixaeron.com',
    SES_FEEDBACK_TOPIC_ARN:
      'arn:aws:sns:eu-central-1:123456789012:pixaeron-feedback',
    SES_FROM_EMAIL: 'Pixaeron <no-reply@pixaeron.com>',
    SES_REQUEST_TIMEOUT_MS: '5000',
    ...overrides,
  });

  return new SesEmailService(
    { send } as unknown as Pick<SESv2Client, 'send'>,
    config,
  );
}
