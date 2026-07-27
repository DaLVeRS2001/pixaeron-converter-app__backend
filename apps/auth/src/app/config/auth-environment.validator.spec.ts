import { validateAuthEnvironment } from './auth-environment.validator';

const validEnvironment = {
  NODE_ENV: 'test',
  PORT: '3000',
  DATABASE_URL: 'postgresql://postgres:postgres@localhost:5432/pixaeron_auth',
  REDIS_URL: 'redis://localhost:6379',
  JWT_SECRET: 'j'.repeat(32),
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

describe('validateAuthEnvironment', () => {
  it('accepts core configuration with optional providers disabled', () => {
    expect(validateAuthEnvironment({ ...validEnvironment })).toEqual(
      validEnvironment,
    );
  });

  it.each(['CAPTCHA_ENABLED', 'EMAIL_DELIVERY_ENABLED'])(
    'rejects a non-exact boolean for %s',
    (key) => {
      expect(() =>
        validateAuthEnvironment({ ...validEnvironment, [key]: 'TRUE' }),
      ).toThrow(`${key} must be exactly "true" or "false"`);
    },
  );

  it.each([
    'NODE_ENV',
    'PORT',
    'DATABASE_URL',
    'REDIS_URL',
    'JWT_SECRET',
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

    expect(() => validateAuthEnvironment(environment)).toThrow(
      `${key} is required`,
    );
  });

  it('reports malformed URLs, weak secrets, wildcard CORS, and invalid Google IDs', () => {
    let message = '';

    try {
      validateAuthEnvironment({
        ...validEnvironment,
        DATABASE_URL: 'mysql://localhost/database',
        REDIS_URL: 'http://localhost:6379',
        JWT_SECRET: 'short',
        IP_HASH_SECRET: 'short',
        CORS_ORIGINS: '*',
        GOOGLE_CLIENT_ID: 'not-a-google-client',
      });
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).toContain('DATABASE_URL uses an unsupported protocol');
    expect(message).toContain('REDIS_URL uses an unsupported protocol');
    expect(message).toContain('JWT_SECRET must contain at least 32 characters');
    expect(message).toContain(
      'IP_HASH_SECRET must contain at least 32 characters',
    );
    expect(message).toContain('CORS_ORIGINS cannot contain "*"');
    expect(message).toContain(
      'GOOGLE_CLIENT_ID must be a Google web OAuth client ID',
    );
  });

  it('validates token lifetime ranges and ordering', () => {
    expect(() =>
      validateAuthEnvironment({
        ...validEnvironment,
        JWT_EXPIRATION_MS: '86400000',
        SESSION_REFRESH_EXPIRATION_MS: '86400000',
        REFRESH_EXPIRATION_MS: '60000',
        REFRESH_TOKEN_HASH_ROUNDS: '9',
      }),
    ).toThrow(
      /JWT_EXPIRATION_MS must be shorter than SESSION_REFRESH_EXPIRATION_MS/,
    );
  });

  it('requires and validates Turnstile settings when CAPTCHA is enabled', () => {
    expect(() =>
      validateAuthEnvironment({
        ...validEnvironment,
        CAPTCHA_ENABLED: 'true',
      }),
    ).toThrow(/CAPTCHA_SECRET_KEY is required/);

    expect(() =>
      validateAuthEnvironment({
        ...validEnvironment,
        CAPTCHA_ENABLED: 'true',
        CAPTCHA_SECRET_KEY: '1x0000000000000000000000000000000AA',
        CAPTCHA_HOSTNAME: 'https://pixaeron.com/auth',
      }),
    ).toThrow(/CAPTCHA_HOSTNAME must be a hostname/);

    expect(() =>
      validateAuthEnvironment({
        ...validEnvironment,
        CAPTCHA_ENABLED: 'true',
        CAPTCHA_SECRET_KEY: '1x0000000000000000000000000000000AA',
        CAPTCHA_HOSTNAME: 'localhost',
      }),
    ).not.toThrow();
  });

  it('requires and validates SES settings when email delivery is enabled', () => {
    expect(() =>
      validateAuthEnvironment({
        ...validEnvironment,
        EMAIL_DELIVERY_ENABLED: 'true',
      }),
    ).toThrow(/AWS_REGION is required/);

    expect(() =>
      validateAuthEnvironment({
        ...validEnvironment,
        EMAIL_DELIVERY_ENABLED: 'true',
        AWS_REGION: 'eu-central-1',
        SES_FROM_EMAIL: 'Pixaeron <no-reply@pixaeron.com>',
        FRONTEND_URL: 'https://pixaeron.com',
      }),
    ).not.toThrow();

    expect(() =>
      validateAuthEnvironment({
        ...validEnvironment,
        EMAIL_DELIVERY_ENABLED: 'true',
        AWS_REGION: 'not-a-region',
        SES_FROM_EMAIL: 'Pixaeron <invalid>',
        FRONTEND_URL: 'ftp://pixaeron.com',
      }),
    ).toThrow(/FRONTEND_URL uses an unsupported protocol/);
  });
});
