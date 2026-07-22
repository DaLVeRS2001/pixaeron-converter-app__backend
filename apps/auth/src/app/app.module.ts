import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { GraphQLModule } from '@pixaeron/graphql';
import { ApolloDriver, ApolloDriverConfig } from '@pixaeron/graphql';
import { RateLimitModule } from '@pixaeron/rate-limit';
import { RedisInfrastructureModule } from '@pixaeron/redis';
import { AuthModule } from './auth/auth.module';
import { SessionModule } from './session/session.module';
import { PrismaModule } from './prisma/prisma.module';
import { UserModule } from './user/user.module';
import { HttpContext } from '@pixaeron/nestjs';
import { HealthController } from './health.controller';
import {
  AUTH_GQL_RATE_LIMITS,
  AUTH_HTTP_RATE_LIMITS,
} from './rate-limit/rate-limit.constants';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    RedisInfrastructureModule.forRoot('auth'),
    RateLimitModule.forRoot({
      namespace: 'auth',
      ipHashSecretConfigKey: 'IP_HASH_SECRET',
      httpLimits: AUTH_HTTP_RATE_LIMITS,
      throttlers: AUTH_GQL_RATE_LIMITS,
    }),
    ScheduleModule.forRoot(),
    PrismaModule,
    SessionModule,
    GraphQLModule.forRoot<ApolloDriverConfig>({
      driver: ApolloDriver,
      graphiql: process.env.NODE_ENV !== 'production',
      autoSchemaFile: true,
      path: 'auth',
      playground:
        process.env.NODE_ENV !== 'production'
          ? {
              settings: {
                'request.credentials': 'include',
              },
            }
          : false,
      context: (data: HttpContext) => data,
    }),
    AuthModule,
    UserModule,
  ],
  controllers: [HealthController],
  providers: [],
})
export class AppModule {}
