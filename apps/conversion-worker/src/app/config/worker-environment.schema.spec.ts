import { workerEnvironmentSchema } from './worker-environment.schema';

const validEnvironment: Record<string, string> = {
  NODE_ENV: 'production',
  AWS_REGION: 'eu-central-1',
  AWS_ACCOUNT_ID: '123456789012',
  AWS_ACCESS_KEY_ID: 'AKIAEXAMPLEEXAMPLE',
  AWS_SECRET_ACCESS_KEY: 'example-secret-access-key-that-is-40-characters',
  CONVERSION_S3_BUCKET: 'pixaeron-conversion-production',
  WORKER_MAX_INPUT_BYTES: '26214400',
  WORKER_MAX_PIXELS: '24000000',
};

const validate = (overrides: Record<string, string | undefined> = {}) => {
  const environment: Record<string, string> = { ...validEnvironment };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete environment[key];
    else environment[key] = value;
  }

  return workerEnvironmentSchema.validate(environment, {
    abortEarly: false,
    allowUnknown: true,
  });
};

describe('workerEnvironmentSchema', () => {
  it('accepts the Lightsail environment and fills the pool defaults', () => {
    const { error, value } = validate();

    expect(error).toBeUndefined();
    expect(value.WORKER_QUEUE_SET).toBe('tiers');
    expect(value.WORKER_SLOTS).toBe(1);
    expect(value.WORKER_PROGRESS_FILE).toBe('/tmp/pixaeron-worker-progress');
  });

  it('accepts a task-role environment without access keys', () => {
    const { error } = validate({
      AWS_ACCESS_KEY_ID: undefined,
      AWS_SECRET_ACCESS_KEY: undefined,
      WORKER_QUEUE_SET: 'paid-large',
    });

    expect(error).toBeUndefined();
  });

  it.each(['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY'])(
    'rejects %s without its pair',
    (variable) => {
      expect(validate({ [variable]: undefined }).error).toBeDefined();
    },
  );

  it.each([
    ['an unknown queue set', { WORKER_QUEUE_SET: 'everything' }],
    ['zero slots', { WORKER_SLOTS: '0' }],
    ['a pool larger than any box', { WORKER_SLOTS: '17' }],
    ['a pixel budget below the floor', { WORKER_MAX_PIXELS: '1' }],
  ])('rejects %s', (_case, overrides) => {
    expect(validate(overrides).error).toBeDefined();
  });

  it('keeps an explicit pool size', () => {
    expect(validate({ WORKER_SLOTS: '4' }).value.WORKER_SLOTS).toBe(4);
  });
});
