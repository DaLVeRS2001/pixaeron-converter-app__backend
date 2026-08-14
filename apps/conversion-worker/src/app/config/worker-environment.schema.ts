import { nodeEnvironment } from '@pixaeron/config';
import * as Joi from 'joi';

export const workerEnvironmentSchema = Joi.object({
  NODE_ENV: nodeEnvironment,
  AWS_REGION: Joi.string().valid('eu-central-1').required(),
  AWS_ACCOUNT_ID: Joi.string()
    .pattern(/^\d{12}$/)
    .required(),
  AWS_ACCESS_KEY_ID: Joi.string().trim().min(16).max(128).required(),
  AWS_SECRET_ACCESS_KEY: Joi.string().trim().min(40).max(256).required(),
  CONVERSION_S3_BUCKET: Joi.string()
    .trim()
    .pattern(/^[a-z0-9.-]{3,63}$/)
    .required(),
  SQS_QUEUE_SUFFIX: Joi.string()
    .pattern(/^-[a-z0-9-]{1,32}$/)
    .optional(),
  CONVERSION_LARGE_FILE_BYTES: Joi.number()
    .integer()
    .min(1_048_576)
    .required()
    .raw(),
  WORKER_MAX_PIXELS: Joi.number()
    .integer()
    .min(1_000_000)
    .max(500_000_000)
    .required()
    .raw(),
});
