import {
  awsAccessKeyId,
  awsAccountId,
  awsRegion,
  awsSecretAccessKey,
  corsOrigins,
  grpcAddress,
  nodeEnvironment,
  port,
  postgresUrl,
  s3BucketName,
  secret,
  sqsQueueSuffix,
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
  AWS_REGION: awsRegion,
  AWS_ACCOUNT_ID: awsAccountId,
  AWS_ACCESS_KEY_ID: awsAccessKeyId,
  AWS_SECRET_ACCESS_KEY: awsSecretAccessKey,
  SQS_QUEUE_SUFFIX: sqsQueueSuffix,
  CONVERSION_S3_BUCKET: s3BucketName,
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
