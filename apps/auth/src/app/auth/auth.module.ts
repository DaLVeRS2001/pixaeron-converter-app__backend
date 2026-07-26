import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PassportModule } from '@nestjs/passport';
import { CaptchaModule } from '@pixaeron/captcha';

import { UserModule } from '../user/user.module';
import { AuthResolver } from './auth.resolver';
import { AuthService } from './auth.service';
import { AuthTokenService } from './auth-token.service';
import { EmailActionAttemptService } from './email-action-attempt.service';
import { GoogleAuthService } from './google-auth.service';
import { LoginAttemptService } from './login-attempt.service';
import { JwtStrategy } from './strategies/jwt.strategy';
import { TransactionalEmailService } from './transactional-email.service';

@Module({
  providers: [
    AuthService,
    AuthResolver,
    AuthTokenService,
    EmailActionAttemptService,
    JwtStrategy,
    GoogleAuthService,
    LoginAttemptService,
    TransactionalEmailService,
  ],
  imports: [CaptchaModule, ConfigModule, PassportModule, UserModule],
})
export class AuthModule {}
