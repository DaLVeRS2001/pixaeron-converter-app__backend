import * as Joi from 'joi';

const integer = (minimum: number, maximum: number) =>
  Joi.number().integer().min(minimum).max(maximum).required().raw();

const booleanValue = Joi.string().valid('true', 'false').required();

const secret = Joi.string()
  .trim()
  .min(32)
  .pattern(/^(?!(?:GENERATE|REPLACE)_).+$/)
  .required()
  .raw()
  .messages({
    'string.pattern.base': '{{#label}} must be replaced with a random secret',
  });

const encodedKey = Joi.string().base64().raw();

const corsOrigins = Joi.string()
  .trim()
  .min(1)
  .required()
  .custom((value: string, helpers) => {
    const origins = value
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean);

    if (origins.length === 0) return helpers.error('cors.empty');

    for (const origin of origins) {
      if (origin === '*') return helpers.error('cors.wildcard');

      try {
        const url = new URL(origin);
        if (
          !['http:', 'https:'].includes(url.protocol) ||
          url.origin !== origin
        ) {
          return helpers.error('cors.origin');
        }
      } catch {
        return helpers.error('cors.origin');
      }
    }

    return value;
  }, 'CORS origins')
  .messages({
    'cors.empty': '{{#label}} must contain at least one origin',
    'cors.wildcard': '{{#label}} cannot contain "*" when credentials are used',
    'cors.origin': '{{#label}} must contain only HTTP(S) origins without paths',
  });

const emailAddress = Joi.string().email({ tlds: { allow: false } });

const sesSender = Joi.string()
  .trim()
  .custom((value: string, helpers) => {
    const match = /^(?:[^<>\r\n]*<([^<>\r\n]+)>|([^<>\r\n]+))$/.exec(value);
    const address = match?.[1] ?? match?.[2];

    return address && !emailAddress.validate(address.trim()).error
      ? value
      : helpers.error('string.email');
  }, 'SES sender')
  .messages({
    'string.email': '{{#label}} must contain a valid email address',
  });

export const authEnvironmentSchema = Joi.object({
  NODE_ENV: Joi.string().valid('development', 'test', 'production').required(),
  PORT: Joi.number().port().required().raw(),
  DATABASE_URL: Joi.string()
    .uri({ scheme: ['postgres', 'postgresql'] })
    .required(),
  REDIS_URL: Joi.string()
    .uri({ scheme: ['redis', 'rediss'] })
    .required(),
  JWT_PRIVATE_KEY_BASE64: encodedKey.required(),
  JWT_PREVIOUS_PUBLIC_KEY_BASE64: encodedKey.optional(),
  JWT_ISSUER: Joi.string()
    .uri({ scheme: ['http', 'https'] })
    .required(),
  JWT_AUDIENCE: Joi.string().trim().min(1).max(255).pattern(/^\S+$/).required(),
  IP_HASH_SECRET: secret,
  CORS_ORIGINS: corsOrigins,

  JWT_EXPIRATION_MS: integer(60_000, 86_400_000).less(
    Joi.ref('SESSION_REFRESH_EXPIRATION_MS'),
  ),
  SESSION_REFRESH_EXPIRATION_MS: integer(60_000, 31_536_000_000).max(
    Joi.ref('REFRESH_EXPIRATION_MS'),
  ),
  REFRESH_EXPIRATION_MS: integer(60_000, 31_536_000_000),
  PASSWORD_HASH_ROUNDS: integer(10, 15),
  REFRESH_TOKEN_HASH_ROUNDS: integer(10, 15),

  GOOGLE_CLIENT_ID: Joi.string()
    .trim()
    .pattern(/^(?!YOUR_)[A-Za-z0-9_-]+\.apps\.googleusercontent\.com$/)
    .required()
    .messages({
      'string.pattern.base': '{{#label}} must be a Google web OAuth client ID',
    }),

  CAPTCHA_ENABLED: booleanValue,
  CAPTCHA_SECRET_KEY: Joi.when('CAPTCHA_ENABLED', {
    is: 'true',
    then: Joi.string().trim().min(20).required(),
    otherwise: Joi.any().optional(),
  }),
  CAPTCHA_HOSTNAME: Joi.when('CAPTCHA_ENABLED', {
    is: 'true',
    then: Joi.alternatives()
      .try(
        Joi.string().trim().valid('localhost'),
        Joi.string()
          .trim()
          .domain({ minDomainSegments: 2, tlds: { allow: false } }),
      )
      .required(),
    otherwise: Joi.any().optional(),
  }),

  EMAIL_DELIVERY_ENABLED: booleanValue,
  AWS_REGION: Joi.when('EMAIL_DELIVERY_ENABLED', {
    is: 'true',
    then: Joi.string()
      .trim()
      .pattern(/^[a-z]{2}(?:-[a-z0-9]+)+-\d+$/)
      .required()
      .messages({
        'string.pattern.base': '{{#label}} must be a valid AWS region',
      }),
    otherwise: Joi.any().optional(),
  }),
  SES_FROM_EMAIL: Joi.when('EMAIL_DELIVERY_ENABLED', {
    is: 'true',
    then: sesSender.required(),
    otherwise: Joi.any().optional(),
  }),
  FRONTEND_URL: Joi.when('EMAIL_DELIVERY_ENABLED', {
    is: 'true',
    then: Joi.string()
      .uri({ scheme: ['http', 'https'] })
      .required(),
    otherwise: Joi.any().optional(),
  }),
});
