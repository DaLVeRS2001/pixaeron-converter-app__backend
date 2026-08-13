import {
  booleanValue,
  nodeEnvironment,
  port,
  postgresUrl,
} from '@pixaeron/config';
import * as Joi from 'joi';

const integer = (minimum: number, maximum: number) =>
  Joi.number().integer().min(minimum).max(maximum).required().raw();

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

function isValidGrpcAddress(value: string): boolean {
  try {
    const address = new URL('grpc://' + value);
    const port = Number(address.port);
    const hasHostAndPort =
      address.hostname.length > 0 && address.port.length > 0;
    const hasValidPort = Number.isInteger(port) && port >= 1 && port <= 65_535;
    const hasCredentials =
      address.username.length > 0 || address.password.length > 0;
    const hasExtraParts =
      address.pathname.length > 0 ||
      address.search.length > 0 ||
      address.hash.length > 0;

    return hasHostAndPort && hasValidPort && !hasCredentials && !hasExtraParts;
  } catch {
    return false;
  }
}

const grpcAddress = Joi.string()
  .trim()
  .custom((value: string, helpers) =>
    isValidGrpcAddress(value) ? value : helpers.error('grpc.address'),
  )
  .messages({
    'grpc.address': '{{#label}} must be a valid gRPC host:port address',
  });

export const authEnvironmentSchema = Joi.object({
  NODE_ENV: nodeEnvironment,
  PORT: port,
  DATABASE_URL: postgresUrl,
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
  NOTIFICATIONS_GRPC_URL: Joi.when('EMAIL_DELIVERY_ENABLED', {
    is: 'true',
    then: grpcAddress.required(),
    otherwise: grpcAddress.optional(),
  }),
  NOTIFICATIONS_GRPC_DEADLINE_MS: Joi.when('EMAIL_DELIVERY_ENABLED', {
    is: 'true',
    then: integer(100, 30_000),
    otherwise: Joi.any().optional(),
  }),
  NOTIFICATIONS_COMMAND_SECRET: Joi.string().min(32).optional().raw(),
  ENTITLEMENTS_GRPC_HOST: Joi.string().hostname().optional(),
  ENTITLEMENTS_GRPC_PORT: Joi.number().port().optional().raw(),
  ENTITLEMENTS_COMMAND_SECRET: Joi.string().min(32).optional().raw(),
  EMAIL_ACTION_RESPONSE_BUDGET_MS: Joi.when('EMAIL_DELIVERY_ENABLED', {
    is: 'true',
    then: integer(101, 60_000).greater(
      Joi.ref('NOTIFICATIONS_GRPC_DEADLINE_MS'),
    ),
    otherwise: Joi.any().optional(),
  }),
}).and('ENTITLEMENTS_GRPC_HOST', 'ENTITLEMENTS_GRPC_PORT');
