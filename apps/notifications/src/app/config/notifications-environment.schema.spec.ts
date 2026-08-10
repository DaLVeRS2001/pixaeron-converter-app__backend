import { notificationsEnvironmentSchema } from './notifications-environment.schema';

const activeHmacKey = Buffer.alloc(32, 'k').toString('base64');
const previousHmacKey = Buffer.alloc(32, 'p').toString('base64');

const validEnvironment = {
  NODE_ENV: 'test',
  PORT: '3004',
  DATABASE_URL:
    'postgresql://postgres:postgres@localhost:5432/pixaeron_notifications',
  NOTIFICATIONS_GRPC_HOST: '127.0.0.1',
  NOTIFICATIONS_GRPC_PORT: '50052',
  RECIPIENT_HMAC_KEYRING_JSON: JSON.stringify({ 2: activeHmacKey }),
  RECIPIENT_HMAC_ACTIVE_KEY_VERSION: '2',
  AWS_REGION: 'eu-central-1',
  AWS_ACCESS_KEY_ID: 'AKIAEXAMPLE123456789',
  AWS_SECRET_ACCESS_KEY: 'x'.repeat(40),
  SES_FROM_EMAIL: 'Pixaeron <no-reply@pixaeron.com>',
  SES_CONFIGURATION_SET: 'pixaeron-transactional',
  SES_REQUEST_TIMEOUT_MS: '1500',
  FRONTEND_URL: 'https://pixaeron.com',
  SES_FEEDBACK_CONSUMER_ENABLED: 'false',
  SES_FEEDBACK_QUEUE_URL:
    'https://sqs.eu-central-1.amazonaws.com/123456789012/pixaeron-feedback',
  SES_FEEDBACK_TOPIC_ARN:
    'arn:aws:sns:eu-central-1:123456789012:pixaeron-feedback',
  SES_EXPECTED_ACCOUNT_ID: '123456789012',
  SES_EXPECTED_SOURCE_ARN:
    'arn:aws:ses:eu-central-1:123456789012:identity/pixaeron.com',
};

function validate(environment: Record<string, unknown>) {
  return notificationsEnvironmentSchema.validate(environment, {
    abortEarly: false,
    allowUnknown: true,
  });
}

describe('notificationsEnvironmentSchema', () => {
  it('accepts the required foundation configuration without rewriting secrets', () => {
    const { error, value } = validate({ ...validEnvironment });

    expect(error).toBeUndefined();
    expect(value).toEqual(validEnvironment);
  });

  it.each([
    'NODE_ENV',
    'PORT',
    'DATABASE_URL',
    'NOTIFICATIONS_GRPC_HOST',
    'NOTIFICATIONS_GRPC_PORT',
    'RECIPIENT_HMAC_KEYRING_JSON',
    'RECIPIENT_HMAC_ACTIVE_KEY_VERSION',
    'AWS_REGION',
    'AWS_ACCESS_KEY_ID',
    'AWS_SECRET_ACCESS_KEY',
    'SES_FROM_EMAIL',
    'SES_CONFIGURATION_SET',
    'SES_REQUEST_TIMEOUT_MS',
    'FRONTEND_URL',
    'SES_FEEDBACK_CONSUMER_ENABLED',
    'SES_FEEDBACK_QUEUE_URL',
    'SES_FEEDBACK_TOPIC_ARN',
    'SES_EXPECTED_ACCOUNT_ID',
    'SES_EXPECTED_SOURCE_ARN',
  ])('rejects a missing foundation variable: %s', (key) => {
    const environment: Record<string, unknown> = { ...validEnvironment };
    delete environment[key];

    const { error } = validate(environment);

    expect(error?.details.some((detail) => detail.path[0] === key)).toBe(true);
  });

  it('accepts every retained HMAC key in one versioned keyring', () => {
    const { error } = validate({
      ...validEnvironment,
      RECIPIENT_HMAC_KEYRING_JSON: JSON.stringify({
        1: previousHmacKey,
        2: activeHmacKey,
      }),
    });

    expect(error).toBeUndefined();
  });

  it.each([
    ['invalid JSON', 'not-json'],
    ['an empty keyring', '{}'],
    [
      'a weak key',
      JSON.stringify({ 2: Buffer.alloc(16, 'k').toString('base64') }),
    ],
    [
      'reused key material',
      JSON.stringify({ 1: activeHmacKey, 2: activeHmacKey }),
    ],
    ['an invalid version', JSON.stringify({ 0: activeHmacKey })],
    ['an invalid key encoding', JSON.stringify({ 2: 'not-base64' })],
  ])('rejects %s', (_case, keyring) => {
    const { error } = validate({
      ...validEnvironment,
      RECIPIENT_HMAC_KEYRING_JSON: keyring,
    });

    expect(error?.message).toContain(
      'must be a JSON object mapping positive integer versions',
    );
  });

  it('requires the active HMAC version to exist in the keyring', () => {
    const { error } = validate({
      ...validEnvironment,
      RECIPIENT_HMAC_ACTIVE_KEY_VERSION: '3',
    });

    expect(error?.message).toContain(
      'RECIPIENT_HMAC_ACTIVE_KEY_VERSION must exist',
    );
  });

  it('rejects malformed database and gRPC endpoints', () => {
    const malformed = validate({
      ...validEnvironment,
      DATABASE_URL: 'mysql://localhost/notifications',
      NOTIFICATIONS_GRPC_HOST: 'http://localhost',
    });
    const invalidKeys = malformed.error?.details.map(
      (detail) => detail.path[0],
    );

    expect(invalidKeys).toEqual(
      expect.arrayContaining(['DATABASE_URL', 'NOTIFICATIONS_GRPC_HOST']),
    );
  });

  it('binds production gRPC only to the private command-network alias', () => {
    const valid = validate({
      ...validEnvironment,
      NODE_ENV: 'production',
      NOTIFICATIONS_GRPC_HOST: 'notifications-command',
      SES_FEEDBACK_CONSUMER_ENABLED: 'true',
    });
    const wildcard = validate({
      ...validEnvironment,
      NODE_ENV: 'production',
      NOTIFICATIONS_GRPC_HOST: '0.0.0.0',
    });

    expect(valid.error).toBeUndefined();
    expect(wildcard.error?.message).toContain(
      'NOTIFICATIONS_GRPC_HOST must use the private notifications-command network alias',
    );
  });
  it('allows an operator to pause feedback consumption in production', () => {
    const { error } = validate({
      ...validEnvironment,
      NODE_ENV: 'production',
      NOTIFICATIONS_GRPC_HOST: 'notifications-command',
      SES_FEEDBACK_CONSUMER_ENABLED: 'false',
    });

    expect(error).toBeUndefined();
  });

  it('requires HTTPS for the production frontend origin', () => {
    const production = validate({
      ...validEnvironment,
      NODE_ENV: 'production',
      FRONTEND_URL: 'http://pixaeron.com',
      SES_FEEDBACK_CONSUMER_ENABLED: 'true',
    });
    const localTest = validate({
      ...validEnvironment,
      FRONTEND_URL: 'http://localhost:3000',
    });

    expect(production.error?.message).toContain(
      'FRONTEND_URL must use HTTPS in production',
    );
    expect(localTest.error).toBeUndefined();
  });

  it('rejects malformed provider configuration', () => {
    const { error } = validate({
      ...validEnvironment,
      AWS_REGION: 'us-east-1',
      SES_FROM_EMAIL: 'not-an-email',
      SES_FEEDBACK_TOPIC_ARN: 'not-an-arn',
      SES_EXPECTED_ACCOUNT_ID: '123',
      FRONTEND_URL: 'https://pixaeron.com/account',
    });
    const invalidKeys = error?.details.map((detail) => detail.path[0]);

    expect(invalidKeys).toEqual(
      expect.arrayContaining([
        'AWS_REGION',
        'SES_FROM_EMAIL',
        'SES_FEEDBACK_TOPIC_ARN',
        'SES_EXPECTED_ACCOUNT_ID',
        'FRONTEND_URL',
      ]),
    );
  });

  it.each([
    [
      'a lookalike hostname',
      'https://sqs.eu-central-1.amazonaws.com.evil.example/123456789012/feedback',
    ],
    [
      'userinfo',
      'https://attacker@sqs.eu-central-1.amazonaws.com/123456789012/feedback',
    ],
    [
      'an explicit port',
      'https://sqs.eu-central-1.amazonaws.com:443/123456789012/feedback',
    ],
    [
      'a query string',
      'https://sqs.eu-central-1.amazonaws.com/123456789012/feedback?target=other',
    ],
    [
      'a fragment',
      'https://sqs.eu-central-1.amazonaws.com/123456789012/feedback#other',
    ],
    [
      'the wrong region',
      'https://sqs.us-east-1.amazonaws.com/123456789012/feedback',
    ],
    [
      'a FIFO queue',
      'https://sqs.eu-central-1.amazonaws.com/123456789012/feedback.fifo',
    ],
  ])('rejects an SQS queue URL containing %s', (_case, queueUrl) => {
    const { error } = validate({
      ...validEnvironment,
      SES_FEEDBACK_QUEUE_URL: queueUrl,
    });

    expect(
      error?.details.some(
        (detail) => detail.path[0] === 'SES_FEEDBACK_QUEUE_URL',
      ),
    ).toBe(true);
  });

  it.each([
    [
      'SNS topic',
      {
        SES_FEEDBACK_TOPIC_ARN:
          'arn:aws:sns:eu-central-1:999999999999:pixaeron-feedback',
      },
    ],
    [
      'SES identity',
      {
        SES_EXPECTED_SOURCE_ARN:
          'arn:aws:ses:eu-central-1:999999999999:identity/pixaeron.com',
      },
    ],
  ])(
    'requires the %s account to match the trusted SES account',
    (_case, override) => {
      const { error } = validate({ ...validEnvironment, ...override });

      expect(error?.message).toContain(
        'SES queue, topic, and identity accounts must match SES_EXPECTED_ACCOUNT_ID',
      );
    },
  );
  it('requires the SQS queue account to match the trusted SES account', () => {
    const { error } = validate({
      ...validEnvironment,
      SES_FEEDBACK_QUEUE_URL:
        'https://sqs.eu-central-1.amazonaws.com/999999999999/feedback',
    });

    expect(error?.message).toContain(
      'SES queue, topic, and identity accounts must match SES_EXPECTED_ACCOUNT_ID',
    );
  });

  it('rejects overlapping HTTP and gRPC listener ports', () => {
    const { error } = validate({
      ...validEnvironment,
      NOTIFICATIONS_GRPC_PORT: validEnvironment.PORT,
    });

    expect(error?.message).toContain(
      'PORT and NOTIFICATIONS_GRPC_PORT must be different',
    );
  });
});
