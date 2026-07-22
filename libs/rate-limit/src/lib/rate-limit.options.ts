import type { ThrottlerOptions } from '@nestjs/throttler';

export interface HttpRateLimit {
  name: string;
  ttl: number;
  limit: number;
}

export interface RateLimitOptions {
  namespace: string;
  ipHashSecretConfigKey: string;
  httpLimits: HttpRateLimit[];
  throttlers: ThrottlerOptions[];
}

export const RATE_LIMIT_OPTIONS = Symbol('RATE_LIMIT_OPTIONS');
