import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { CaptchaModule } from '@pixaeron/captcha';
import { join } from 'node:path';

import { PrismaModule } from '../prisma/prisma.module';
import { SessionModule } from '../session/session.module';
import { UserModule } from '../user/user.module';
import { AuthEmailDeliveryService } from './email/auth-email-delivery.service';
import { EmailActionAttemptService } from './email/email-action-attempt.service';
import {
  NOTIFICATIONS_GRPC_CLIENT,
  NotificationsEmailClient,
} from './email/notifications-email.client';
import { GoogleSignInService } from './google/google-sign-in.service';
import { GoogleTokenService } from './google/google-token.service';
import { AuthResolver } from './auth.resolver';
import { AuthChallengePolicyService } from './services/auth-challenge-policy.service';
import { AuthTokenService } from './services/auth-token.service';
import { LoginAttemptService } from './password/login-attempt.service';
import { PasswordRecoveryService } from './password/password-recovery.service';
import { PasswordSignInService } from './password/password-sign-in.service';
import { RegistrationService } from './registration/registration.service';

export const AUTH_RESOLVERS = [AuthResolver];

const notificationsProtoPath = join(
  __dirname,
  'proto/pixaeron/notifications/v1/notifications.proto',
);

@Module({
  imports: [
    CaptchaModule,
    ConfigModule,
    ClientsModule.registerAsync([
      {
        name: NOTIFICATIONS_GRPC_CLIENT,
        imports: [ConfigModule],
        inject: [ConfigService],
        useFactory: (configService: ConfigService) => ({
          transport: Transport.GRPC,
          options: {
            package: 'pixaeron.notifications.v1',
            protoPath: notificationsProtoPath,
            url: configService.get<string>('NOTIFICATIONS_GRPC_URL'),
            channelOptions: {
              'grpc.enable_retries': 0,
            },
          },
        }),
      },
    ]),
    PrismaModule,
    SessionModule,
    UserModule,
  ],
  providers: [
    ...AUTH_RESOLVERS,
    PasswordSignInService,
    RegistrationService,
    PasswordRecoveryService,
    GoogleSignInService,
    GoogleTokenService,
    AuthChallengePolicyService,
    AuthTokenService,
    AuthEmailDeliveryService,
    NotificationsEmailClient,
    LoginAttemptService,
    EmailActionAttemptService,
  ],
})
export class AuthModule {}
