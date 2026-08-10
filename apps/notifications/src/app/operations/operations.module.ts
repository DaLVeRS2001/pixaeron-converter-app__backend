import { Module } from '@nestjs/common';

import { DeliveryModule } from '../delivery/delivery.module';
import { EmailRecoveryService } from './email-recovery.service';
import { EmailRetentionService } from './email-retention.service';
import { EmailSubmissionReconciliationService } from './email-submission-reconciliation.service';

@Module({
  imports: [DeliveryModule],
  providers: [
    EmailRecoveryService,
    EmailRetentionService,
    EmailSubmissionReconciliationService,
  ],
  exports: [EmailRecoveryService],
})
export class OperationsModule {}
