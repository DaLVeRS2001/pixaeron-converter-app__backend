-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "EmailPurpose" AS ENUM ('EMAIL_VERIFICATION', 'PASSWORD_RESET');

-- CreateEnum
CREATE TYPE "EmailDeliveryStatus" AS ENUM ('PENDING', 'ACCEPTED', 'DELIVERED', 'DELAYED', 'BOUNCED', 'COMPLAINED', 'REJECTED', 'FAILED', 'SUBMISSION_UNKNOWN', 'SUPPRESSED');

-- CreateEnum
CREATE TYPE "EmailCommandResult" AS ENUM ('ACCEPTED', 'FAILED', 'REJECTED', 'SUPPRESSED', 'SUBMISSION_UNKNOWN');

-- CreateEnum
CREATE TYPE "EmailDeliveryEventType" AS ENUM ('SEND', 'DELIVERY', 'DELIVERY_DELAY', 'BOUNCE', 'COMPLAINT', 'REJECT', 'RENDERING_FAILURE');

-- CreateEnum
CREATE TYPE "EmailDestinationStatus" AS ENUM ('ACTIVE', 'TEMPORARY_FAILURE', 'SUPPRESSED', 'RECOVERY_PENDING');

-- CreateEnum
CREATE TYPE "EmailRecoveryAction" AS ENUM ('REQUESTED', 'COMPLETED', 'FAILED');

-- CreateTable
CREATE TABLE "email_deliveries" (
    "id" UUID NOT NULL,
    "request_id" UUID NOT NULL,
    "public_subject" UUID NOT NULL,
    "recipient_hash" VARCHAR(64) NOT NULL,
    "recipient_hash_key_version" INTEGER NOT NULL,
    "purpose" "EmailPurpose" NOT NULL,
    "content_version" INTEGER NOT NULL,
    "token_fingerprint" VARCHAR(64) NOT NULL,
    "status" "EmailDeliveryStatus" NOT NULL DEFAULT 'PENDING',
    "caller_result" "EmailCommandResult",
    "caller_result_code" VARCHAR(100),
    "provider_message_id" VARCHAR(255),
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "lease_expires_at" TIMESTAMPTZ(3),
    "failure_code" VARCHAR(100),
    "submitted_at" TIMESTAMPTZ(3),
    "finalized_at" TIMESTAMPTZ(3),
    "last_event_at" TIMESTAMPTZ(3),
    "last_event_rank" INTEGER,
    "last_event_fingerprint" VARCHAR(64),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "email_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email_delivery_events" (
    "id" UUID NOT NULL,
    "delivery_id" UUID NOT NULL,
    "event_type" "EmailDeliveryEventType" NOT NULL,
    "sns_message_id" VARCHAR(255),
    "provider_feedback_id" VARCHAR(255),
    "subtype" VARCHAR(100),
    "provider_message_id" VARCHAR(255) NOT NULL,
    "semantic_fingerprint" VARCHAR(64) NOT NULL,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL,
    "received_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "details" JSONB,

    CONSTRAINT "email_delivery_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email_destinations" (
    "id" UUID NOT NULL,
    "recipient_hash" VARCHAR(64) NOT NULL,
    "recipient_hash_key_version" INTEGER NOT NULL,
    "status" "EmailDestinationStatus" NOT NULL DEFAULT 'ACTIVE',
    "reason_code" VARCHAR(100),
    "suppressed_at" TIMESTAMPTZ(3),
    "last_delivery_id" UUID,
    "last_event_id" UUID,
    "last_event_at" TIMESTAMPTZ(3),
    "last_event_rank" INTEGER,
    "last_event_fingerprint" VARCHAR(64),
    "suppression_revision" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "email_destinations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email_recovery_audits" (
    "id" UUID NOT NULL,
    "destination_id" UUID NOT NULL,
    "operation_id" UUID NOT NULL,
    "action" "EmailRecoveryAction" NOT NULL,
    "actor_id" VARCHAR(128) NOT NULL,
    "reason_code" VARCHAR(100) NOT NULL,
    "evidence_reference" VARCHAR(255) NOT NULL,
    "previous_status" "EmailDestinationStatus" NOT NULL,
    "next_status" "EmailDestinationStatus" NOT NULL,
    "provider_request_id" VARCHAR(255),
    "failure_code" VARCHAR(100),
    "suppression_revision" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_recovery_audits_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "email_deliveries_request_id_key" ON "email_deliveries"("request_id");

-- CreateIndex
CREATE UNIQUE INDEX "email_deliveries_provider_message_id_key" ON "email_deliveries"("provider_message_id");

-- CreateIndex
CREATE INDEX "email_deliveries_status_lease_expires_at_idx" ON "email_deliveries"("status", "lease_expires_at");

-- CreateIndex
CREATE INDEX "email_deliveries_status_created_at_idx" ON "email_deliveries"("status", "created_at");

-- CreateIndex
CREATE INDEX "email_deliveries_status_last_event_at_idx" ON "email_deliveries"("status", "last_event_at");

-- CreateIndex
CREATE INDEX "email_deliveries_recipient_hash_recipient_hash_key_version__idx" ON "email_deliveries"("recipient_hash", "recipient_hash_key_version", "created_at");

-- CreateIndex
CREATE INDEX "email_deliveries_public_subject_purpose_created_at_idx" ON "email_deliveries"("public_subject", "purpose", "created_at");

-- CreateIndex
CREATE INDEX "email_deliveries_created_at_idx" ON "email_deliveries"("created_at");

-- CreateIndex
CREATE UNIQUE INDEX "email_delivery_events_sns_message_id_key" ON "email_delivery_events"("sns_message_id");

-- CreateIndex
CREATE UNIQUE INDEX "email_delivery_events_semantic_fingerprint_key" ON "email_delivery_events"("semantic_fingerprint");

-- CreateIndex
CREATE INDEX "email_delivery_events_delivery_id_occurred_at_idx" ON "email_delivery_events"("delivery_id", "occurred_at");

-- CreateIndex
CREATE INDEX "email_delivery_events_provider_message_id_occurred_at_idx" ON "email_delivery_events"("provider_message_id", "occurred_at");

-- CreateIndex
CREATE INDEX "email_delivery_events_provider_feedback_id_idx" ON "email_delivery_events"("provider_feedback_id");

-- CreateIndex
CREATE INDEX "email_delivery_events_event_type_occurred_at_idx" ON "email_delivery_events"("event_type", "occurred_at");

-- CreateIndex
CREATE INDEX "email_delivery_events_received_at_idx" ON "email_delivery_events"("received_at");

-- CreateIndex
CREATE INDEX "email_destinations_status_updated_at_idx" ON "email_destinations"("status", "updated_at");

-- CreateIndex
CREATE INDEX "email_destinations_status_last_event_at_idx" ON "email_destinations"("status", "last_event_at");

-- CreateIndex
CREATE INDEX "email_destinations_last_delivery_id_idx" ON "email_destinations"("last_delivery_id");

-- CreateIndex
CREATE INDEX "email_destinations_last_event_id_idx" ON "email_destinations"("last_event_id");

-- CreateIndex
CREATE UNIQUE INDEX "email_destinations_recipient_hash_recipient_hash_key_versio_key" ON "email_destinations"("recipient_hash", "recipient_hash_key_version");

-- CreateIndex
CREATE UNIQUE INDEX "email_recovery_audits_operation_id_destination_id_key" ON "email_recovery_audits"("operation_id", "destination_id");

-- CreateIndex
CREATE INDEX "email_recovery_audits_operation_id_idx" ON "email_recovery_audits"("operation_id");

-- CreateIndex
CREATE INDEX "email_recovery_audits_destination_id_created_at_idx" ON "email_recovery_audits"("destination_id", "created_at");

-- CreateIndex
CREATE INDEX "email_recovery_audits_actor_id_created_at_idx" ON "email_recovery_audits"("actor_id", "created_at");

-- CreateIndex
CREATE INDEX "email_recovery_audits_created_at_idx" ON "email_recovery_audits"("created_at");

-- AddForeignKey
ALTER TABLE "email_delivery_events" ADD CONSTRAINT "email_delivery_events_delivery_id_fkey" FOREIGN KEY ("delivery_id") REFERENCES "email_deliveries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_recovery_audits" ADD CONSTRAINT "email_recovery_audits_destination_id_fkey" FOREIGN KEY ("destination_id") REFERENCES "email_destinations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- Enforce invariants Prisma cannot represent in the schema.
ALTER TABLE "email_deliveries"
  ADD CONSTRAINT "email_deliveries_positive_hash_key_version_check"
    CHECK ("recipient_hash_key_version" > 0),
  ADD CONSTRAINT "email_deliveries_positive_content_version_check"
    CHECK ("content_version" > 0),
  ADD CONSTRAINT "email_deliveries_token_fingerprint_check"
    CHECK ("token_fingerprint" ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT "email_deliveries_single_attempt_check"
    CHECK ("attempt_count" >= 0 AND "attempt_count" <= 1),
  ADD CONSTRAINT "email_deliveries_caller_result_code_check"
    CHECK ("caller_result" IS NOT NULL OR "caller_result_code" IS NULL),
  ADD CONSTRAINT "email_deliveries_last_event_revision_check"
    CHECK (
      ("last_event_at" IS NULL AND "last_event_rank" IS NULL AND "last_event_fingerprint" IS NULL)
      OR
      ("last_event_at" IS NOT NULL AND "last_event_rank" IS NOT NULL AND "last_event_rank" >= 0 AND "last_event_fingerprint" ~ '^[0-9a-f]{64}$')
    );

ALTER TABLE "email_destinations"
  ADD CONSTRAINT "email_destinations_positive_hash_key_version_check"
    CHECK ("recipient_hash_key_version" > 0),
  ADD CONSTRAINT "email_destinations_suppression_revision_check"
    CHECK ("suppression_revision" >= 0),
  ADD CONSTRAINT "email_destinations_last_event_revision_check"
    CHECK (
      ("last_event_at" IS NULL AND "last_event_rank" IS NULL AND "last_event_fingerprint" IS NULL)
      OR
      ("last_event_at" IS NOT NULL AND "last_event_rank" IS NOT NULL AND "last_event_rank" >= 0 AND "last_event_fingerprint" ~ '^[0-9a-f]{64}$')
    );

ALTER TABLE "email_recovery_audits"
  ADD CONSTRAINT "email_recovery_audits_suppression_revision_check"
    CHECK ("suppression_revision" >= 0);

-- Feedback and recovery history is append-only. Retention jobs may still delete expired records.
CREATE FUNCTION "reject_append_only_update"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER "email_delivery_events_reject_update"
BEFORE UPDATE ON "email_delivery_events"
FOR EACH ROW EXECUTE FUNCTION "reject_append_only_update"();

CREATE TRIGGER "email_recovery_audits_reject_update"
BEFORE UPDATE ON "email_recovery_audits"
FOR EACH ROW EXECUTE FUNCTION "reject_append_only_update"();

-- Once returned to the caller, the command result is historical and cannot be rewritten.
CREATE FUNCTION "preserve_email_delivery_caller_result"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD."caller_result" IS NOT NULL
     AND (
       NEW."caller_result" IS DISTINCT FROM OLD."caller_result"
       OR NEW."caller_result_code" IS DISTINCT FROM OLD."caller_result_code"
     ) THEN
    RAISE EXCEPTION 'email delivery caller result is immutable once set'
      USING ERRCODE = '55000';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "email_deliveries_preserve_caller_result"
BEFORE UPDATE ON "email_deliveries"
FOR EACH ROW EXECUTE FUNCTION "preserve_email_delivery_caller_result"();
