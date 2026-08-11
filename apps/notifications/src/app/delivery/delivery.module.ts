import { Module } from '@nestjs/common';

import { CommandAuthenticationGuard } from './command-authentication.guard';
import { SecurityEmailController } from './security-email.controller';
import { RecipientHashService } from './recipient-hash.service';
import { SecurityEmailService } from './security-email.service';
import { SesEmailService, sesEmailClientProvider } from './ses-email.service';

@Module({
  controllers: [SecurityEmailController],
  providers: [
    CommandAuthenticationGuard,
    RecipientHashService,
    sesEmailClientProvider,
    SesEmailService,
    SecurityEmailService,
  ],
  exports: [RecipientHashService],
})
export class DeliveryModule {}
