import { conversionEnvironmentSchema } from './conversion-environment.schema';

const validEnvironment: Record<string, string> = {
  NODE_ENV: 'development',
  PORT: '3005',
  DATABASE_URL:
    'postgresql://conversion:conversion@127.0.0.1:5435/pixaeron_conversion?schema=public',
  CORS_ORIGINS: 'http://localhost:3000',
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
});
