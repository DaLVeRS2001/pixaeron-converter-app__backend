import {
  booleanValue,
  corsOrigins,
  grpcAddress,
  nodeEnvironment,
  port,
  postgresUrl,
  secret,
} from '@pixaeron/config';
import * as Joi from 'joi';

const integer = (minimum: number, maximum: number) =>
  Joi.number().integer().min(minimum).max(maximum).required().raw();

const encodedKey = Joi.string().base64().raw();

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
