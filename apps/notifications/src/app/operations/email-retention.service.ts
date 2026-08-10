import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';

import { EmailDestinationStatus } from '../../generated/prisma/client';
import type { Transaction } from '../prisma/prisma.support';
import { PrismaService } from '../prisma/prisma.service';

const RETENTION_DAYS = 90;
const CLEANUP_LOCK_ID = 739_428_011_223_344;

@Injectable()
export class EmailRetentionService {
  private readonly logger = new Logger(EmailRetentionService.name);

  private readonly activeRecipientHashKeyVersion: number;

  constructor(
    private readonly prisma: PrismaService,
    configService: ConfigService,
  ) {
    this.activeRecipientHashKeyVersion = Number(
      configService.getOrThrow<string>('RECIPIENT_HMAC_ACTIVE_KEY_VERSION'),
    );
  }

  @Cron('0 3 * * *')
  async cleanupExpiredHistory(): Promise<void> {
    const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1_000);

    const result = await this.prisma.$transaction(
      async (transaction) => {
        const [lock] = await transaction.$queryRaw<
          { acquired: boolean }[]
        >`SELECT pg_try_advisory_xact_lock(${CLEANUP_LOCK_ID}) AS acquired`;

        if (!lock?.acquired) return null;

        const events = await transaction.emailDeliveryEvent.deleteMany({
          where: { receivedAt: { lt: cutoff } },
        });
        const recoveryAudits = await transaction.emailRecoveryAudit.deleteMany({
          where: { createdAt: { lt: cutoff } },
        });
        const deliveries = await transaction.emailDelivery.deleteMany({
          where: {
            createdAt: { lt: cutoff },
            events: { none: {} },
          },
        });
        const retiredNonBlockingAliases =
          await transaction.emailDestination.deleteMany({
            where: {
              recipientHashKeyVersion: {
                not: this.activeRecipientHashKeyVersion,
              },
              status: {
                in: [
                  EmailDestinationStatus.ACTIVE,
                  EmailDestinationStatus.TEMPORARY_FAILURE,
                ],
              },
              recoveryAudits: { none: {} },
            },
          });
        const retiredBlockingAliases =
          await this.deleteEquivalentRetiredBlockingAliases(transaction);

        return {
          events: events.count,
          recoveryAudits: recoveryAudits.count,
          deliveries: deliveries.count,
          retiredNonBlockingAliases: retiredNonBlockingAliases.count,
          retiredBlockingAliases,
        };
      },
      { timeout: 30_000 },
    );

    if (!result) {
      this.logger.log(
        'Email retention cleanup skipped: another runner owns it',
      );
      return;
    }

    this.logger.log(
      'Email retention cleanup completed: ' +
        `${result.deliveries} deliveries, ` +
        `${result.events} events, ` +
        `${result.recoveryAudits} recovery audits, ` +
        `${result.retiredNonBlockingAliases} retired non-blocking aliases, ` +
        `${result.retiredBlockingAliases} retired blocking aliases`,
    );
  }

  private deleteEquivalentRetiredBlockingAliases(
    transaction: Transaction,
  ): Promise<number> {
    const activeKeyVersion = this.activeRecipientHashKeyVersion;

    return transaction.$executeRaw`
      DELETE FROM "email_destinations" AS "old_destination"
      WHERE "old_destination"."recipient_hash_key_version" <> ${activeKeyVersion}
        AND "old_destination"."status" IN (
          'SUPPRESSED'::"EmailDestinationStatus",
          'RECOVERY_PENDING'::"EmailDestinationStatus"
        )
        AND "old_destination"."last_event_id" IS NOT NULL
        AND NOT EXISTS (
          SELECT 1
          FROM "email_recovery_audits" AS "recovery_audit"
          WHERE "recovery_audit"."destination_id" = "old_destination"."id"
        )
        AND EXISTS (
          SELECT 1
          FROM "email_destinations" AS "active_destination"
          WHERE "active_destination"."recipient_hash_key_version" = ${activeKeyVersion}
            AND "active_destination"."status" = "old_destination"."status"
            AND "active_destination"."last_event_id" = "old_destination"."last_event_id"
            AND "active_destination"."last_delivery_id" IS NOT DISTINCT FROM "old_destination"."last_delivery_id"
            AND "active_destination"."last_event_at" IS NOT DISTINCT FROM "old_destination"."last_event_at"
            AND "active_destination"."last_event_rank" IS NOT DISTINCT FROM "old_destination"."last_event_rank"
            AND "active_destination"."last_event_fingerprint" IS NOT DISTINCT FROM "old_destination"."last_event_fingerprint"
            AND "active_destination"."reason_code" IS NOT DISTINCT FROM "old_destination"."reason_code"
            AND "active_destination"."suppression_revision" = "old_destination"."suppression_revision"
        )
    `;
  }
}
