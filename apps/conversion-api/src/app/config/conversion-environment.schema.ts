import {
  corsOrigins,
  grpcAddress,
  nodeEnvironment,
  port,
  postgresUrl,
  secret,
} from '@pixaeron/config';
import * as Joi from 'joi';

export const conversionEnvironmentSchema = Joi.object({
  NODE_ENV: nodeEnvironment,
  PORT: port,
  DATABASE_URL: postgresUrl,
  REDIS_URL: Joi.string()
    .uri({ scheme: ['redis', 'rediss'] })
    .required(),
  IP_HASH_SECRET: secret,
  CORS_ORIGINS: corsOrigins,
  AWS_REGION: Joi.string().valid('eu-central-1').required(),
  AWS_ACCOUNT_ID: Joi.string()
    .pattern(/^\d{12}$/)
    .required(),
  AWS_ACCESS_KEY_ID: Joi.string().trim().min(16).max(128).required(),
  AWS_SECRET_ACCESS_KEY: Joi.string().trim().min(40).max(256).required(),
  SQS_QUEUE_SUFFIX: Joi.string()
    .pattern(/^-[a-z0-9-]{1,32}$/)
    .optional(),
  CONVERSION_S3_BUCKET: Joi.string()
    .trim()
    .pattern(/^[a-z0-9.-]{3,63}$/)
    .required(),
  ENTITLEMENTS_GRPC_URL: grpcAddress.required(),
  ENTITLEMENTS_GRPC_DEADLINE_MS: Joi.number()
    .integer()
    .min(100)
    .max(30_000)
    .required()
    .raw(),
  CONVERSION_LARGE_FILE_BYTES: Joi.number()
    .integer()
    .min(1_048_576)
    .required()
    .raw(),
  ENTITLEMENTS_COMMAND_SECRET: Joi.string().min(32).optional().raw(),
});
