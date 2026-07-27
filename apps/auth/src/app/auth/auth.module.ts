import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { CaptchaModule } from '@pixaeron/captcha';

import { PrismaModule } from '../prisma/prisma.module';
import { SessionModule } from '../session/session.module';
import { UserModule } from '../user/user.module';
import { AuthEmailDeliveryService } from './email/auth-email-delivery.service';
import { EmailActionAttemptService } from './email/email-action-attempt.service';
import { TransactionalEmailService } from './email/transactional-email.service';
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

@Module({
  imports: [
    CaptchaModule,
    ConfigModule,
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
    TransactionalEmailService,
    LoginAttemptService,
    EmailActionAttemptService,
  ],
})
export class AuthModule {}
