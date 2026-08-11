import {
  booleanValue,
  nodeEnvironment,
  port,
  postgresUrl,
} from '@pixaeron/config';
import * as Joi from 'joi';

import { parseSenderAddress } from '../delivery/sender-address';
const keyVersion = Joi.number().integer().min(1).max(2_147_483_647).raw();
const emailAddress = Joi.string().email({ tlds: { allow: false } });
const sqsQueueUrlPattern =
  /^https:\/\/sqs\.eu-central-1\.amazonaws\.com\/(\d{12})\/[A-Za-z0-9_-]{1,80}$/;
const snsTopicArnPattern =
  /^arn:aws:sns:eu-central-1:(\d{12}):[A-Za-z0-9_.+=,@/-]+$/;
const sesIdentityArnPattern =
  /^arn:aws:ses:eu-central-1:(\d{12}):identity\/[A-Za-z0-9_.@-]+$/;

const recipientHmacKeyring = Joi.string()
  .custom((value: string, helpers) => {
    return parseRecipientHmacKeyring(value)
      ? value
      : helpers.error('notifications.hmacKeyring');
  }, 'recipient HMAC keyring')
  .required()
  .raw()
  .messages({
    'notifications.hmacKeyring':
      '{{#label}} must be a JSON object mapping positive integer versions to distinct base64 keys of at least 32 bytes',
  });

const sesSender = Joi.string()
  .trim()
  .custom((value: string, helpers) => {
    const address = parseSenderAddress(value);

    return address && !emailAddress.validate(address).error
      ? value
      : helpers.error('string.email');
  }, 'SES sender')
  .messages({
    'string.email': '{{#label}} must contain a valid email address',
  });

const httpOrigin = Joi.string()
  .uri({ scheme: ['http', 'https'] })
  .custom((value: string, helpers) => {
    try {
      return new URL(value).origin === value
        ? value
        : helpers.error('notifications.origin');
    } catch {
      return helpers.error('notifications.origin');
    }
  }, 'HTTP origin')
  .messages({
    'notifications.origin':
      '{{#label}} must be an HTTP(S) origin without a path',
  });

const grpcHost = Joi.alternatives()
  .try(Joi.string().ip({ version: ['ipv4'] }), Joi.string().hostname())
  .required();

export const notificationsEnvironmentSchema = Joi.object({
  NODE_ENV: nodeEnvironment,
  PORT: port,
  DATABASE_URL: postgresUrl,

  NOTIFICATIONS_GRPC_HOST: grpcHost,
  NOTIFICATIONS_GRPC_PORT: port,
  NOTIFICATIONS_COMMAND_SECRET: Joi.string().min(32).optional().raw(),

  RECIPIENT_HMAC_KEYRING_JSON: recipientHmacKeyring,
  RECIPIENT_HMAC_ACTIVE_KEY_VERSION: keyVersion.required(),

  AWS_REGION: Joi.string().valid('eu-central-1').required(),
  AWS_ACCESS_KEY_ID: Joi.string().trim().min(16).max(128).required(),
  AWS_SECRET_ACCESS_KEY: Joi.string().trim().min(40).max(256).required(),
  SES_FROM_EMAIL: sesSender.required(),
  SES_CONFIGURATION_SET: Joi.string().trim().min(1).max(64).required(),
  SES_REQUEST_TIMEOUT_MS: Joi.number()
    .integer()
    .min(100)
    .max(30_000)
    .required()
    .raw(),
  FRONTEND_URL: httpOrigin.required(),

  SES_FEEDBACK_CONSUMER_ENABLED: booleanValue,
  SES_FEEDBACK_QUEUE_URL: Joi.string()
    .pattern(sqsQueueUrlPattern)
    .required()
    .messages({
      'string.pattern.base':
        '{{#label}} must be an exact eu-central-1 Standard SQS queue URL',
    }),
  SES_FEEDBACK_TOPIC_ARN: Joi.string().pattern(snsTopicArnPattern).required(),
  SES_EXPECTED_ACCOUNT_ID: Joi.string()
    .pattern(/^\d{12}$/)
    .required(),
  SES_EXPECTED_SOURCE_ARN: Joi.string()
    .pattern(sesIdentityArnPattern)
    .required(),
})
  .custom((environment: Record<string, unknown>, helpers) => {
    const httpPort = String(environment['PORT']);
    const grpcPort = String(environment['NOTIFICATIONS_GRPC_PORT']);
    if (httpPort === grpcPort) {
      return helpers.error('notifications.portCollision');
    }

    if (environment['NODE_ENV'] === 'production') {
      const frontendUrl = new URL(String(environment['FRONTEND_URL']));
      if (frontendUrl.protocol !== 'https:') {
        return helpers.error('notifications.productionFrontendHttps');
      }

      if (environment['NOTIFICATIONS_GRPC_HOST'] !== 'notifications-command') {
        return helpers.error('notifications.productionGrpcHost');
      }
    }

    const keyring = parseRecipientHmacKeyring(
      String(environment['RECIPIENT_HMAC_KEYRING_JSON']),
    );
    const activeVersion = Number(
      environment['RECIPIENT_HMAC_ACTIVE_KEY_VERSION'],
    );
    if (!keyring?.has(activeVersion)) {
      return helpers.error('notifications.activeHmacKeyMissing');
    }

    const queueUrl = String(environment['SES_FEEDBACK_QUEUE_URL']);
    const expectedAccountId = environment['SES_EXPECTED_ACCOUNT_ID'];
    const queueAccountId = sqsQueueUrlPattern.exec(queueUrl)?.[1];
    const topicAccountId = snsTopicArnPattern.exec(
      String(environment['SES_FEEDBACK_TOPIC_ARN']),
    )?.[1];
    const identityAccountId = sesIdentityArnPattern.exec(
      String(environment['SES_EXPECTED_SOURCE_ARN']),
    )?.[1];
    const providerAccounts = [
      queueAccountId,
      topicAccountId,
      identityAccountId,
    ];

    if (providerAccounts.some((accountId) => accountId !== expectedAccountId)) {
      return helpers.error('notifications.providerAccountMismatch');
    }

    return environment;
  }, 'Notifications environment consistency')
  .messages({
    'notifications.portCollision':
      'PORT and NOTIFICATIONS_GRPC_PORT must be different',
    'notifications.productionFrontendHttps':
      'FRONTEND_URL must use HTTPS in production',
    'notifications.productionGrpcHost':
      'NOTIFICATIONS_GRPC_HOST must use the private notifications-command network alias in production',
    'notifications.activeHmacKeyMissing':
      'RECIPIENT_HMAC_ACTIVE_KEY_VERSION must exist in RECIPIENT_HMAC_KEYRING_JSON',
    'notifications.providerAccountMismatch':
      'SES queue, topic, and identity accounts must match SES_EXPECTED_ACCOUNT_ID',
  });

function parseRecipientHmacKeyring(value: string): Map<number, Buffer> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }

  if (
    !parsed ||
    typeof parsed !== 'object' ||
    Array.isArray(parsed) ||
    Object.getPrototypeOf(parsed) !== Object.prototype
  ) {
    return null;
  }

  const entries = Object.entries(parsed);
  if (entries.length === 0) return null;

  const keyring = new Map<number, Buffer>();
  const keyMaterials = new Set<string>();

  for (const [versionValue, encodedKey] of entries) {
    if (
      !/^[1-9]\d*$/.test(versionValue) ||
      Number(versionValue) > 2_147_483_647 ||
      typeof encodedKey !== 'string'
    ) {
      return null;
    }

    const key = decodeBase64(encodedKey);
    if (!key || key.byteLength < 32) return null;

    const keyMaterial = key.toString('hex');
    if (keyMaterials.has(keyMaterial)) return null;

    keyring.set(Number(versionValue), key);
    keyMaterials.add(keyMaterial);
  }

  return keyring;
}

function decodeBase64(value: string): Buffer | null {
  if (
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      value,
    )
  ) {
    return null;
  }

  return Buffer.from(value, 'base64');
}
