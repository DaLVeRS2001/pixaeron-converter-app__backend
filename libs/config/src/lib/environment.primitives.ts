import * as Joi from 'joi';

export const awsAccessKeyId = Joi.string().trim().min(16).max(128).required();

export const awsAccountId = Joi.string()
  .pattern(/^\d{12}$/)
  .required();

export const awsRegion = Joi.string().valid('eu-central-1').required();

export const awsSecretAccessKey = Joi.string()
  .trim()
  .min(40)
  .max(256)
  .required();

export const booleanValue = Joi.string().valid('true', 'false').required();

export const s3BucketName = Joi.string()
  .trim()
  .pattern(/^[a-z0-9.-]{3,63}$/)
  .required();

export const sqsQueueSuffix = Joi.string()
  .pattern(/^-[a-z0-9-]{1,32}$/)
  .optional();

export const nodeEnvironment = Joi.string()
  .valid('development', 'test', 'production')
  .required();

export const port = Joi.number().port().required().raw();

export const postgresUrl = Joi.string()
  .uri({ scheme: ['postgres', 'postgresql'] })
  .required();

export const secret = Joi.string()
  .trim()
  .min(32)
  .pattern(/^(?!(?:GENERATE|REPLACE)_).+$/)
  .required()
  .raw()
  .messages({
    'string.pattern.base': '{{#label}} must be replaced with a random secret',
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

export const grpcAddress = Joi.string()
  .trim()
  .custom((value: string, helpers) =>
    isValidGrpcAddress(value) ? value : helpers.error('grpc.address'),
  )
  .messages({
    'grpc.address': '{{#label}} must be a valid gRPC host:port address',
  });

export function parseCorsOrigins(value: string): string[] {
  return value
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
}

export const corsOrigins = Joi.string()
  .trim()
  .min(1)
  .required()
  .custom((value: string, helpers) => {
    const origins = parseCorsOrigins(value);

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
