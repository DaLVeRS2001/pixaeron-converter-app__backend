import { createGraphQLErrorFormatter } from '@pixaeron/graphql';

const publicErrorCodes = new Set([
  'ACCOUNT_LINK_REQUIRED',
  'AUTH_ACTION_COOLDOWN',
  'CAPTCHA_INVALID',
  'CAPTCHA_REQUIRED',
  'CAPTCHA_UNAVAILABLE',
  'EMAIL_ALREADY_REGISTERED',
  'EMAIL_DELIVERY_UNAVAILABLE',
  'EMAIL_NOT_VERIFIED',
  'GOOGLE_EMAIL_NOT_VERIFIED',
  'GOOGLE_TOKEN_INVALID',
  'LEGAL_CONSENT_REQUIRED',
  'TOO_MANY_AUTH_ATTEMPTS',
  'TOO_MANY_LOGIN_ATTEMPTS',
]);

export const formatAuthGraphQLError =
  createGraphQLErrorFormatter(publicErrorCodes);
