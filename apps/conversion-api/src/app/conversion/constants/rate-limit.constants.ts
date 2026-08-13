import { minutes, seconds } from '@nestjs/throttler';

export const CONVERSION_HTTP_RATE_LIMITS = [
  { name: 'second', ttl: seconds(1), limit: 20 },
  { name: 'minute', ttl: minutes(1), limit: 300 },
  { name: 'quarter-hour', ttl: minutes(15), limit: 3_000 },
];

export const CONVERSION_GQL_RATE_LIMITS = [
  { name: 'short', limit: 10, ttl: seconds(1) },
  { name: 'medium', limit: 120, ttl: minutes(1) },
  { name: 'long', limit: 1_000, ttl: minutes(15) },
];

export const CONVERSION_MUTATION_RATE_LIMIT = {
  short: { limit: 3, ttl: seconds(1) },
  medium: { limit: 30, ttl: minutes(1) },
  long: { limit: 200, ttl: minutes(15) },
};
