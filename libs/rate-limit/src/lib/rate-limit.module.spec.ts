import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { RedisToken } from '@pixaeron/redis';

import { RateLimitModule } from './rate-limit.module';

const TEST_SECRET_KEY = 'RATE_LIMIT_TEST_IP_HASH_SECRET';

@Global()
@Module({
  providers: [{ provide: RedisToken(), useValue: {} }],
  exports: [RedisToken()],
})
class MockRedisModule {}

describe('RateLimitModule', () => {
  it('compiles with a non-global ConfigModule', async () => {
    process.env[TEST_SECRET_KEY] = 'test-secret-with-at-least-32-characters';

    try {
      const moduleRef = await Test.createTestingModule({
        imports: [
          ConfigModule.forRoot({ isGlobal: false, ignoreEnvFile: true }),
          MockRedisModule,
          RateLimitModule.forRoot({
            namespace: 'test',
            ipHashSecretConfigKey: TEST_SECRET_KEY,
            httpLimits: [],
            throttlers: [],
          }),
        ],
      }).compile();

      await moduleRef.close();
    } finally {
      delete process.env[TEST_SECRET_KEY];
    }
  });
});
