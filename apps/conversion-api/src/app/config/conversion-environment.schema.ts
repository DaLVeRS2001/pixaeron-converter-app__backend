import {
  corsOrigins,
  grpcAddress,
  nodeEnvironment,
  port,
  postgresUrl,
} from '@pixaeron/config';
import * as Joi from 'joi';

export const conversionEnvironmentSchema = Joi.object({
  NODE_ENV: nodeEnvironment,
  PORT: port,
  DATABASE_URL: postgresUrl,
  CORS_ORIGINS: corsOrigins,
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
