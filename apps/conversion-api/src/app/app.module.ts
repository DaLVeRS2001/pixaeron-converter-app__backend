import { ApolloServerPluginInlineTraceDisabled } from '@apollo/server/plugin/disabled';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import {
  ApolloFederationDriver,
  ApolloFederationDriverConfig,
  GraphQLModule,
} from '@pixaeron/graphql';
import { HttpContext } from '@pixaeron/nestjs';
import { RateLimitModule } from '@pixaeron/rate-limit';
import { RedisInfrastructureModule } from '@pixaeron/redis';

import { conversionEnvironmentSchema } from './config/conversion-environment.schema';
import {
  CONVERSION_GQL_RATE_LIMITS,
  CONVERSION_HTTP_RATE_LIMITS,
} from './conversion/constants/rate-limit.constants';
import { ConversionModule } from './conversion/conversion.module';
import { formatConversionGraphQLError } from './graphql-error-contract';
import { HealthController } from './health.controller';
import { PrismaModule } from './prisma/prisma.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validationSchema: conversionEnvironmentSchema,
      validationOptions: {
        abortEarly: false,
        allowUnknown: true,
      },
    }),
    RedisInfrastructureModule.forRoot('conversion'),
    RateLimitModule.forRoot({
      namespace: 'conversion',
      ipHashSecretConfigKey: 'IP_HASH_SECRET',
      httpLimits: CONVERSION_HTTP_RATE_LIMITS,
      throttlers: CONVERSION_GQL_RATE_LIMITS,
    }),
    GraphQLModule.forRoot<ApolloFederationDriverConfig>({
      driver: ApolloFederationDriver,
      autoSchemaFile: { federation: 2 },
      sortSchema: true,
      plugins: [ApolloServerPluginInlineTraceDisabled()],
      path: 'conversion',
      graphiql: process.env.NODE_ENV !== 'production',
      formatError: formatConversionGraphQLError,
      context: (data: HttpContext) => data,
    }),
    PrismaModule,
    ConversionModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
