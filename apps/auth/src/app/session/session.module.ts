import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';

import { SessionAuditService } from './audit/session-audit.service';
import { GqlSessionAuthGuard } from './guards/gql-session-auth.guard';
import { SessionCleanupService } from './services/session-cleanup.service';
import { SessionCookieService } from './services/session-cookie.service';
import { SessionMetadataService } from './services/session-metadata.service';
import { SessionTokenService } from './services/session-token.service';
import { SessionService } from './services/session.service';

@Module({
  imports: [
    ConfigModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        secret: configService.getOrThrow('JWT_SECRET'),
        signOptions: {
          expiresIn: configService.getOrThrow('JWT_EXPIRATION_MS'),
        },
      }),
    }),
  ],
  providers: [
    SessionService,
    SessionTokenService,
    SessionCookieService,
    SessionMetadataService,
    SessionAuditService,
    SessionCleanupService,
    GqlSessionAuthGuard,
  ],
  exports: [
    SessionService,
    SessionMetadataService,
    SessionAuditService,
    GqlSessionAuthGuard,
  ],
})
export class SessionModule {}
