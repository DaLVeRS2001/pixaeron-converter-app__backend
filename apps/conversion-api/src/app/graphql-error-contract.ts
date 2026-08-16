import { createGraphQLErrorFormatter } from '@pixaeron/graphql';

const publicErrorCodes = new Set([
  'BATCH_NOT_ADMITTABLE',
  'BATCH_SIZE_INVALID',
  'BATCH_TOKEN_MISMATCH',
  'DAILY_QUOTA_EXCEEDED',
  'ENTITLEMENTS_UNAVAILABLE',
  'FILE_NOT_MEASURED',
  'FILE_TOO_LARGE',
  'IDEMPOTENCY_CONFLICT',
]);

export const formatConversionGraphQLError =
  createGraphQLErrorFormatter(publicErrorCodes);
