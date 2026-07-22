import { minutes, seconds } from '@nestjs/throttler';

export const AUTH_RATE_LIMIT = {
  short: { limit: 3, ttl: seconds(1) },
  medium: { limit: 10, ttl: minutes(1) },
  long: { limit: 50, ttl: minutes(15) },
};
