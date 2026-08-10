import { authEnvironmentSchema } from './auth-environment.schema';

const validEnvironment = {
  NODE_ENV: 'test',
  PORT: '3000',
  DATABASE_URL: 'postgresql://postgres:postgres@localhost:5432/pixaeron_auth',
  REDIS_URL: 'redis://localhost:6379',
  JWT_PRIVATE_KEY_BASE64: Buffer.alloc(512, 'k').toString('base64'),
  JWT_ISSUER: 'https://api.pixaeron.com/auth',
  JWT_AUDIENCE: 'pixaeron-api',
  JWT_EXPIRATION_MS: '900000',
  REFRESH_EXPIRATION_MS: '604800000',
  SESSION_REFRESH_EXPIRATION_MS: '86400000',
  PASSWORD_HASH_ROUNDS: '12',
  REFRESH_TOKEN_HASH_ROUNDS: '12',
  IP_HASH_SECRET: 'i'.repeat(32),
  CORS_ORIGINS: 'http://localhost:3000,https://pixaeron.com',
  GOOGLE_CLIENT_ID: '123456-example.apps.googleusercontent.com',
  CAPTCHA_ENABLED: 'false',
  EMAIL_DELIVERY_ENABLED: 'false',
};

function validate(environment: Record<string, unknown>) {
  return authEnvironmentSchema.validate(environment, {
    abortEarly: false,
    allowUnknown: true,
  });
}

describe('authEnvironmentSchema', () => {
  it('accepts core configuration without changing string values', () => {
    const { error, value } = validate({ ...validEnvironment });

    expect(error).toBeUndefined();
    expect(value).toEqual(validEnvironment);
    expect(value.JWT_EXPIRATION_MS).toBe('900000');
    expect(value.CAPTCHA_ENABLED).toBe('false');
  });

  it('does not rewrite validated key and secret material', () => {
    const privateKey = Buffer.alloc(512, 'p').toString('base64');
    const ipHashSecret = ` ${'i'.repeat(32)} `;
    const { error, value } = validate({
      ...validEnvironment,
      JWT_PRIVATE_KEY_BASE64: privateKey,
      IP_HASH_SECRET: ipHashSecret,
    });

    expect(error).toBeUndefined();
    expect(value.JWT_PRIVATE_KEY_BASE64).toBe(privateKey);
    expect(value.IP_HASH_SECRET).toBe(ipHashSecret);
  });

  it('does not echo a rejected CORS value in the startup error', () => {
    const rejectedOrigin =
      'https://user:private@example.com/path?token=private';
    const { error } = validate({
      ...validEnvironment,
      CORS_ORIGINS: rejectedOrigin,
    });

    expect(error).toBeDefined();
    expect(error?.message).not.toContain(rejectedOrigin);
  });

  it.each(['CAPTCHA_ENABLED', 'EMAIL_DELIVERY_ENABLED'])(
    'rejects a non-exact boolean for %s',
    (key) => {
      const { error } = validate({ ...validEnvironment, [key]: 'TRUE' });

      expect(error?.details.some((detail) => detail.path[0] === key)).toBe(
        true,
      );
    },
  );

  it.each([
    'NODE_ENV',
    'PORT',
    'DATABASE_URL',
    'REDIS_URL',
    'JWT_PRIVATE_KEY_BASE64',
    'JWT_ISSUER',
    'JWT_AUDIENCE',
    'JWT_EXPIRATION_MS',
    'REFRESH_EXPIRATION_MS',
    'SESSION_REFRESH_EXPIRATION_MS',
    'PASSWORD_HASH_ROUNDS',
    'REFRESH_TOKEN_HASH_ROUNDS',
    'IP_HASH_SECRET',
    'CORS_ORIGINS',
    'GOOGLE_CLIENT_ID',
    'CAPTCHA_ENABLED',
    'EMAIL_DELIVERY_ENABLED',
  ])('rejects a missing core variable: %s', (key) => {
    const environment: Record<string, unknown> = { ...validEnvironment };
    delete environment[key];

    const { error } = validate(environment);

    expect(error?.details.some((detail) => detail.path[0] === key)).toBe(true);
  });

  it('rejects malformed URLs, weak secrets, wildcard CORS, and invalid Google IDs', () => {
    const { error } = validate({
      ...validEnvironment,
      DATABASE_URL: 'mysql://localhost/database',
      REDIS_URL: 'http://localhost:6379',
      JWT_PRIVATE_KEY_BASE64: 'not-base64',
      JWT_ISSUER: 'ftp://api.pixaeron.com/auth',
      JWT_AUDIENCE: 'pixaeron api',
      IP_HASH_SECRET: 'short',
      CORS_ORIGINS: '*',
      GOOGLE_CLIENT_ID: 'YOUR_GOOGLE_CLIENT_ID.apps.googleusercontent.com',
    });
    const invalidKeys = error?.details.map((detail) => detail.path[0]);

    expect(invalidKeys).toEqual(
      expect.arrayContaining([
        'DATABASE_URL',
        'REDIS_URL',
        'JWT_PRIVATE_KEY_BASE64',
        'JWT_ISSUER',
        'JWT_AUDIENCE',
        'IP_HASH_SECRET',
        'CORS_ORIGINS',
        'GOOGLE_CLIENT_ID',
      ]),
    );
  });

  it('validates token lifetime ranges and ordering', () => {
    const { error } = validate({
      ...validEnvironment,
      JWT_EXPIRATION_MS: '86400000',
      SESSION_REFRESH_EXPIRATION_MS: '86400000',
      REFRESH_EXPIRATION_MS: '60000',
      REFRESH_TOKEN_HASH_ROUNDS: '9',
    });
    const invalidKeys = error?.details.map((detail) => detail.path[0]);

    expect(invalidKeys).toEqual(
      expect.arrayContaining([
        'JWT_EXPIRATION_MS',
        'SESSION_REFRESH_EXPIRATION_MS',
        'REFRESH_TOKEN_HASH_ROUNDS',
      ]),
    );
  });

  it('requires and validates Turnstile settings only when CAPTCHA is enabled', () => {
    const missing = validate({
      ...validEnvironment,
      CAPTCHA_ENABLED: 'true',
    });
    const invalid = validate({
      ...validEnvironment,
      CAPTCHA_ENABLED: 'true',
      CAPTCHA_SECRET_KEY: '1x0000000000000000000000000000000AA',
      CAPTCHA_HOSTNAME: 'internal',
    });
    const valid = validate({
      ...validEnvironment,
      CAPTCHA_ENABLED: 'true',
      CAPTCHA_SECRET_KEY: '1x0000000000000000000000000000000AA',
      CAPTCHA_HOSTNAME: 'localhost',
    });

    expect(missing.error?.details.map((detail) => detail.path[0])).toEqual(
      expect.arrayContaining(['CAPTCHA_SECRET_KEY', 'CAPTCHA_HOSTNAME']),
    );
    expect(
      invalid.error?.details.some(
        (detail) => detail.path[0] === 'CAPTCHA_HOSTNAME',
      ),
    ).toBe(true);
    expect(valid.error).toBeUndefined();
  });

  it('requires valid Notifications gRPC settings when email delivery is enabled', () => {
    const missing = validate({
      ...validEnvironment,
      EMAIL_DELIVERY_ENABLED: 'true',
    });
    const valid = validate({
      ...validEnvironment,
      EMAIL_DELIVERY_ENABLED: 'true',
      NOTIFICATIONS_GRPC_URL: 'notifications:50052',
      NOTIFICATIONS_GRPC_DEADLINE_MS: '2000',
      EMAIL_ACTION_RESPONSE_BUDGET_MS: '2500',
    });
    const invalid = validate({
      ...validEnvironment,
      EMAIL_DELIVERY_ENABLED: 'true',
      NOTIFICATIONS_GRPC_URL: 'https://notifications:50052/path',
      NOTIFICATIONS_GRPC_DEADLINE_MS: '99',
      EMAIL_ACTION_RESPONSE_BUDGET_MS: '99',
    });
    const invalidKeys = invalid.error?.details.map((detail) => detail.path[0]);

    expect(missing.error?.details.map((detail) => detail.path[0])).toEqual(
      expect.arrayContaining([
        'NOTIFICATIONS_GRPC_URL',
        'NOTIFICATIONS_GRPC_DEADLINE_MS',
        'EMAIL_ACTION_RESPONSE_BUDGET_MS',
      ]),
    );
    expect(valid.error).toBeUndefined();
    expect(invalidKeys).toEqual(
      expect.arrayContaining([
        'NOTIFICATIONS_GRPC_URL',
        'NOTIFICATIONS_GRPC_DEADLINE_MS',
        'EMAIL_ACTION_RESPONSE_BUDGET_MS',
      ]),
    );
  });

  it('requires the public email-action budget to exceed the gRPC deadline', () => {
    const { error } = validate({
      ...validEnvironment,
      EMAIL_DELIVERY_ENABLED: 'true',
      NOTIFICATIONS_GRPC_URL: '[::1]:50052',
      NOTIFICATIONS_GRPC_DEADLINE_MS: '2000',
      EMAIL_ACTION_RESPONSE_BUDGET_MS: '2000',
    });

    expect(
      error?.details.some(
        (detail) => detail.path[0] === 'EMAIL_ACTION_RESPONSE_BUDGET_MS',
      ),
    ).toBe(true);
  });
});
