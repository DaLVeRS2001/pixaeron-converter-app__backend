import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';

import { SessionAuditService } from './audit/session-audit.service';
import { GqlSessionAuthGuard } from './guards/gql-session-auth.guard';
import { JwksController } from './jwks.controller';
import { AccessTokenKeyService } from './services/access-token-key.service';
import { SessionCleanupService } from './services/session-cleanup.service';
import { SessionCookieService } from './services/session-cookie.service';
import { SessionMetadataService } from './services/session-metadata.service';
import { SessionTokenService } from './services/session-token.service';
import { SessionService } from './services/session.service';

@Module({
  imports: [ConfigModule, JwtModule.register({})],
  controllers: [JwksController],
  providers: [
    AccessTokenKeyService,
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
