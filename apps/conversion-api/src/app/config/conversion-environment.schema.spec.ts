import { conversionEnvironmentSchema } from './conversion-environment.schema';

const validEnvironment: Record<string, string> = {
  NODE_ENV: 'development',
  PORT: '3005',
  DATABASE_URL:
    'postgresql://conversion:conversion@127.0.0.1:5435/pixaeron_conversion?schema=public',
  REDIS_URL: 'redis://127.0.0.1:6379',
  IP_HASH_SECRET: 'conversion-ip-hash-secret-32-chars-long',
  CORS_ORIGINS: 'http://localhost:3000',
  AWS_REGION: 'eu-central-1',
  AWS_ACCOUNT_ID: '123456789012',
  AWS_ACCESS_KEY_ID: 'AKIAEXAMPLEEXAMPLE',
  AWS_SECRET_ACCESS_KEY: 'example-secret-access-key-that-is-40-characters',
  CONVERSION_S3_BUCKET: 'pixaeron-conversion-dev',
  SQS_QUEUE_SUFFIX: '-dev',
  ENTITLEMENTS_GRPC_URL: '127.0.0.1:50053',
  ENTITLEMENTS_GRPC_DEADLINE_MS: '2000',
  CONVERSION_LARGE_FILE_BYTES: '26214400',
};

const validate = (overrides: Record<string, string | undefined> = {}) => {
  const environment: Record<string, string> = { ...validEnvironment };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete environment[key];
    else environment[key] = value;
  }

  return conversionEnvironmentSchema.validate(environment, {
    abortEarly: false,
    allowUnknown: true,
  });
};

describe('conversionEnvironmentSchema', () => {
  it('accepts a complete environment', () => {
    expect(validate().error).toBeUndefined();
  });

  it.each(Object.keys(validEnvironment))('rejects a missing %s', (variable) => {
    expect(validate({ [variable]: undefined }).error).toBeDefined();
  });

  it.each([
    ['a zero port', 'auth:0'],
    ['an out-of-range port', 'auth:99999'],
    ['a path', 'auth:50053/entitlements'],
    ['credentials', 'user:secret@auth:50053'],
    ['a missing port', 'auth'],
  ])('rejects a gRPC address with %s', (_case, value) => {
    expect(validate({ ENTITLEMENTS_GRPC_URL: value }).error).toBeDefined();
  });

  it.each([
    ['below the minimum', '99'],
    ['above the maximum', '30001'],
    ['not a number', 'fast'],
  ])('rejects a deadline %s', (_case, value) => {
    expect(
      validate({ ENTITLEMENTS_GRPC_DEADLINE_MS: value }).error,
    ).toBeDefined();
  });

  it('rejects a short command secret and accepts a full-length one', () => {
    expect(
      validate({ ENTITLEMENTS_COMMAND_SECRET: 'too-short' }).error,
    ).toBeDefined();
    expect(
      validate({
        ENTITLEMENTS_COMMAND_SECRET: 'entitlements-secret-that-is-32-chars',
      }).error,
    ).toBeUndefined();
  });

  it('rejects a wildcard CORS origin', () => {
    expect(validate({ CORS_ORIGINS: '*' }).error).toBeDefined();
  });

  it.each([
    ['a non-numeric account id', 'account'],
    ['a short account id', '12345678901'],
  ])('rejects %s', (_case, value) => {
    expect(validate({ AWS_ACCOUNT_ID: value }).error).toBeDefined();
  });

  it('accepts a -dev queue suffix and rejects a bare one', () => {
    expect(validate({ SQS_QUEUE_SUFFIX: '-dev' }).error).toBeUndefined();
    expect(validate({ SQS_QUEUE_SUFFIX: 'dev' }).error).toBeDefined();
  });

  it('demands a queue suffix outside production so dev never shares the live queues', () => {
    expect(
      validate({ NODE_ENV: 'development', SQS_QUEUE_SUFFIX: undefined }).error,
    ).toBeDefined();
    expect(
      validate({ NODE_ENV: 'production', SQS_QUEUE_SUFFIX: undefined }).error,
    ).toBeUndefined();
  });
});
