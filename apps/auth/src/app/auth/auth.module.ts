import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PassportModule } from '@nestjs/passport';
import { UserModule } from '../user/user.module';
import { AuthResolver } from './auth.resolver';
import { AuthService } from './auth.service';
import { CaptchaService } from './captcha.service';
import { GoogleAuthService } from './google-auth.service';
import { JwtStrategy } from './strategies/jwt.strategy';
import { LoginAttemptService } from './login-attempt.service';

@Module({
  providers: [
    AuthService,
    AuthResolver,
    JwtStrategy,
    CaptchaService,
    GoogleAuthService,
    LoginAttemptService,
  ],
  imports: [ConfigModule, PassportModule, UserModule],
})
export class AuthModule {}
