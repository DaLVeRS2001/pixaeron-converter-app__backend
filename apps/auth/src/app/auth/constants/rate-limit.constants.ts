import { minutes, seconds } from '@nestjs/throttler';

export const AUTH_HTTP_RATE_LIMITS = [
  { name: 'second', ttl: seconds(1), limit: 30 },
  { name: 'minute', ttl: minutes(1), limit: 600 },
  { name: 'quarter-hour', ttl: minutes(15), limit: 6_000 },
];

export const AUTH_GQL_RATE_LIMITS = [
  { name: 'short', limit: 20, ttl: seconds(1) },
  { name: 'medium', limit: 300, ttl: minutes(1) },
  { name: 'long', limit: 3_000, ttl: minutes(15) },
];

export const AUTH_RATE_LIMIT = {
  short: { limit: 3, ttl: seconds(1) },
  medium: { limit: 10, ttl: minutes(1) },
  long: { limit: 50, ttl: minutes(15) },
};
