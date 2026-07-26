const BOOLEAN_VALUES = new Set(['true', 'false']);
const GOOGLE_CLIENT_ID_PATTERN =
  /^[A-Za-z0-9_-]+\.apps\.googleusercontent\.com$/;
const HOSTNAME_PATTERN =
  /^(?:localhost|(?=.{1,253}$)(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,63})$/;
const AWS_REGION_PATTERN = /^[a-z]{2}(?:-[a-z0-9]+)+-\d+$/;
const EMAIL_ADDRESS_PATTERN = /^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/;

type Environment = Record<string, unknown>;

function readRequiredString(
  config: Environment,
  key: string,
  errors: string[],
): string | undefined {
  const value = config[key];

  if (typeof value !== 'string' || value.trim() === '') {
    errors.push(`${key} is required`);
    return undefined;
  }

  return value.trim();
}

function validateBoolean(
  config: Environment,
  key: string,
  errors: string[],
): boolean | undefined {
  const value = readRequiredString(config, key, errors);

  if (value === undefined) return undefined;
  if (!BOOLEAN_VALUES.has(value)) {
    errors.push(`${key} must be exactly "true" or "false"`);
    return undefined;
  }

  return value === 'true';
}

function validateInteger(
  config: Environment,
  key: string,
  minimum: number,
  maximum: number,
  errors: string[],
): number | undefined {
  const value = readRequiredString(config, key, errors);
  const parsed = value === undefined ? Number.NaN : Number(value);

  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    errors.push(`${key} must be an integer between ${minimum} and ${maximum}`);
    return undefined;
  }

  return parsed;
}

function validateUrl(
  value: string | undefined,
  key: string,
  protocols: ReadonlySet<string>,
  errors: string[],
): URL | undefined {
  if (value === undefined) return undefined;

  try {
    const url = new URL(value);

    if (!protocols.has(url.protocol)) {
      errors.push(`${key} uses an unsupported protocol`);
      return undefined;
    }

    return url;
  } catch {
    errors.push(`${key} must be a valid URL`);
    return undefined;
  }
}

function validateSecret(
  config: Environment,
  key: string,
  errors: string[],
): void {
  const value = readRequiredString(config, key, errors);

  if (value === undefined) return;

  if (/^(?:GENERATE|REPLACE)_/.test(value)) {
    errors.push(`${key} must be replaced with a random secret`);
  } else if (value.length < 32) {
    errors.push(`${key} must contain at least 32 characters`);
  }
}

function validateCorsOrigins(config: Environment, errors: string[]): void {
  const value = readRequiredString(config, 'CORS_ORIGINS', errors);

  if (value === undefined) return;

  const origins = value
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

  if (origins.length === 0) {
    errors.push('CORS_ORIGINS must contain at least one origin');
    return;
  }

  for (const origin of origins) {
    if (origin === '*') {
      errors.push('CORS_ORIGINS cannot contain "*" when credentials are used');
      continue;
    }

    const url = validateUrl(
      origin,
      'CORS_ORIGINS',
      new Set(['http:', 'https:']),
      errors,
    );

    if (url && url.origin !== origin) {
      errors.push(`CORS_ORIGINS must contain origins without paths: ${origin}`);
    }
  }
}

function validateSender(value: string | undefined, errors: string[]): void {
  if (value === undefined) return;
  if (/[\r\n]/.test(value)) {
    errors.push('SES_FROM_EMAIL cannot contain line breaks');
    return;
  }

  const angleAddress = value.match(/^[^<>]*<([^<>]+)>$/)?.[1]?.trim();
  const address = angleAddress ?? value;

  if (!EMAIL_ADDRESS_PATTERN.test(address)) {
    errors.push('SES_FROM_EMAIL must contain a valid email address');
  }
}

export function validateAuthEnvironment(config: Environment): Environment {
  const errors: string[] = [];

  const nodeEnv = readRequiredString(config, 'NODE_ENV', errors);
  if (
    nodeEnv !== undefined &&
    !['development', 'test', 'production'].includes(nodeEnv)
  ) {
    errors.push('NODE_ENV must be development, test, or production');
  }

  validateInteger(config, 'PORT', 1, 65_535, errors);
  validateUrl(
    readRequiredString(config, 'DATABASE_URL', errors),
    'DATABASE_URL',
    new Set(['postgres:', 'postgresql:']),
    errors,
  );
  validateUrl(
    readRequiredString(config, 'REDIS_URL', errors),
    'REDIS_URL',
    new Set(['redis:', 'rediss:']),
    errors,
  );
  validateSecret(config, 'JWT_SECRET', errors);
  validateSecret(config, 'IP_HASH_SECRET', errors);
  validateCorsOrigins(config, errors);

  const accessLifetime = validateInteger(
    config,
    'JWT_EXPIRATION_MS',
    60_000,
    86_400_000,
    errors,
  );
  const sessionRefreshLifetime = validateInteger(
    config,
    'SESSION_REFRESH_EXPIRATION_MS',
    60_000,
    31_536_000_000,
    errors,
  );
  const rememberedRefreshLifetime = validateInteger(
    config,
    'REFRESH_EXPIRATION_MS',
    60_000,
    31_536_000_000,
    errors,
  );
  validateInteger(config, 'REFRESH_TOKEN_HASH_ROUNDS', 10, 15, errors);

  if (
    accessLifetime !== undefined &&
    sessionRefreshLifetime !== undefined &&
    accessLifetime >= sessionRefreshLifetime
  ) {
    errors.push(
      'JWT_EXPIRATION_MS must be shorter than SESSION_REFRESH_EXPIRATION_MS',
    );
  }
  if (
    sessionRefreshLifetime !== undefined &&
    rememberedRefreshLifetime !== undefined &&
    sessionRefreshLifetime > rememberedRefreshLifetime
  ) {
    errors.push(
      'SESSION_REFRESH_EXPIRATION_MS cannot exceed REFRESH_EXPIRATION_MS',
    );
  }

  const googleClientId = readRequiredString(config, 'GOOGLE_CLIENT_ID', errors);
  if (
    googleClientId !== undefined &&
    (googleClientId.startsWith('YOUR_') ||
      !GOOGLE_CLIENT_ID_PATTERN.test(googleClientId))
  ) {
    errors.push('GOOGLE_CLIENT_ID must be a Google web OAuth client ID');
  }

  const captchaEnabled = validateBoolean(config, 'CAPTCHA_ENABLED', errors);
  if (captchaEnabled) {
    const secret = readRequiredString(config, 'CAPTCHA_SECRET_KEY', errors);
    const hostname = readRequiredString(config, 'CAPTCHA_HOSTNAME', errors);

    if (secret !== undefined && secret.length < 20) {
      errors.push('CAPTCHA_SECRET_KEY must contain at least 20 characters');
    }
    if (hostname !== undefined && !HOSTNAME_PATTERN.test(hostname)) {
      errors.push('CAPTCHA_HOSTNAME must be a hostname without a URL or path');
    }
  }

  const emailDeliveryEnabled = validateBoolean(
    config,
    'EMAIL_DELIVERY_ENABLED',
    errors,
  );
  if (emailDeliveryEnabled) {
    const region = readRequiredString(config, 'AWS_REGION', errors);
    const sender = readRequiredString(config, 'SES_FROM_EMAIL', errors);

    validateUrl(
      readRequiredString(config, 'FRONTEND_URL', errors),
      'FRONTEND_URL',
      new Set(['http:', 'https:']),
      errors,
    );
    if (region !== undefined && !AWS_REGION_PATTERN.test(region)) {
      errors.push('AWS_REGION must be a valid AWS region identifier');
    }
    validateSender(sender, errors);
  }

  if (errors.length > 0) {
    throw new Error(
      `Invalid auth environment configuration:\n- ${errors.join('\n- ')}`,
    );
  }

  return config;
}
