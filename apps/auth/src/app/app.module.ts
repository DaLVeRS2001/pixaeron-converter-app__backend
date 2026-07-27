import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import {
  ApolloDriver,
  ApolloDriverConfig,
  GraphQLModule,
} from '@pixaeron/graphql';
import { HttpContext } from '@pixaeron/nestjs';
import { RateLimitModule } from '@pixaeron/rate-limit';
import { RedisInfrastructureModule } from '@pixaeron/redis';

import { AuthModule } from './auth/auth.module';
import { authEnvironmentSchema } from './config/auth-environment.schema';
import { formatAuthGraphQLError } from './graphql-error-contract';
import { HealthController } from './health.controller';
import { PrismaModule } from './prisma/prisma.module';
import {
  AUTH_GQL_RATE_LIMITS,
  AUTH_HTTP_RATE_LIMITS,
} from './auth/constants/rate-limit.constants';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validationSchema: authEnvironmentSchema,
      validationOptions: {
        abortEarly: false,
        allowUnknown: true,
      },
    }),
    RedisInfrastructureModule.forRoot('auth'),
    RateLimitModule.forRoot({
      namespace: 'auth',
      ipHashSecretConfigKey: 'IP_HASH_SECRET',
      httpLimits: AUTH_HTTP_RATE_LIMITS,
      throttlers: AUTH_GQL_RATE_LIMITS,
    }),
    ScheduleModule.forRoot(),
    PrismaModule,
    GraphQLModule.forRoot<ApolloDriverConfig>({
      driver: ApolloDriver,
      autoSchemaFile: true,
      sortSchema: true,
      path: 'auth',
      graphiql: process.env.NODE_ENV !== 'production',
      formatError: formatAuthGraphQLError,
      context: (data: HttpContext) => data,
    }),
    AuthModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
