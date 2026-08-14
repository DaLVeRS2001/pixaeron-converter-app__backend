import {
  awsAccessKeyId,
  awsAccountId,
  awsRegion,
  awsSecretAccessKey,
  nodeEnvironment,
  s3BucketName,
  sqsQueueSuffix,
} from '@pixaeron/config';
import * as Joi from 'joi';

export const workerEnvironmentSchema = Joi.object({
  NODE_ENV: nodeEnvironment,
  AWS_REGION: awsRegion,
  AWS_ACCOUNT_ID: awsAccountId,
  AWS_ACCESS_KEY_ID: awsAccessKeyId,
  AWS_SECRET_ACCESS_KEY: awsSecretAccessKey,
  CONVERSION_S3_BUCKET: s3BucketName,
  SQS_QUEUE_SUFFIX: Joi.when('NODE_ENV', {
    is: 'production',
    then: sqsQueueSuffix,
    otherwise: sqsQueueSuffix.required(),
  }),
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
  WORKER_PROGRESS_FILE: Joi.string()
    .trim()
    .min(1)
    .default('/tmp/pixaeron-worker-progress'),
});
