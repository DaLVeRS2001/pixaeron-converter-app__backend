-- CreateEnum
CREATE TYPE "ConversionPlanCode" AS ENUM ('ANONYMOUS', 'FREE', 'LIGHT', 'PRO');

-- CreateEnum
CREATE TYPE "ConversionBatchStatus" AS ENUM ('UPLOADING', 'QUEUED', 'PROCESSING', 'COMPLETED', 'PARTIAL', 'FAILED', 'CANCELLED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "ConversionFileStatus" AS ENUM ('UPLOADING', 'READY', 'QUEUED', 'PROCESSING', 'COMPLETED', 'FAILED', 'CANCELLED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "ConversionResultKind" AS ENUM ('SAVED', 'NO_SAVINGS', 'SANITIZED_LARGER');

-- CreateEnum
CREATE TYPE "OutboxEventStatus" AS ENUM ('PENDING', 'DELIVERED');

-- CreateTable
CREATE TABLE "conversion_batches" (
    "id" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "batch_token_hash" TEXT,
    "idempotency_key" TEXT NOT NULL,
    "plan_code" "ConversionPlanCode" NOT NULL,
    "plan_revision" INTEGER NOT NULL,
    "status" "ConversionBatchStatus" NOT NULL DEFAULT 'UPLOADING',
    "file_count" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "conversion_batches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conversion_files" (
    "id" TEXT NOT NULL,
    "batch_id" TEXT NOT NULL,
    "status" "ConversionFileStatus" NOT NULL DEFAULT 'UPLOADING',
    "input_object_key" TEXT NOT NULL,
    "input_etag" TEXT,
    "output_object_key" TEXT,
    "input_format" TEXT,
    "output_format" TEXT,
    "input_bytes" BIGINT,
    "output_bytes" BIGINT,
    "output_checksum" TEXT,
    "result_kind" "ConversionResultKind",
    "width" INTEGER,
    "height" INTEGER,
    "frame_count" INTEGER,
    "attempt" INTEGER NOT NULL DEFAULT 0,
    "failure_code" TEXT,
    "started_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "conversion_files_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "daily_usage" (
    "subject" TEXT NOT NULL,
    "usage_date" DATE NOT NULL,
    "admitted_files" INTEGER NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "daily_usage_pkey" PRIMARY KEY ("subject","usage_date")
);

-- CreateTable
CREATE TABLE "outbox_events" (
    "id" TEXT NOT NULL,
    "queue" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "OutboxEventStatus" NOT NULL DEFAULT 'PENDING',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "delivered_at" TIMESTAMP(3),

    CONSTRAINT "outbox_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "conversion_batches_subject_created_at_idx" ON "conversion_batches"("subject", "created_at" DESC);

-- CreateIndex
CREATE INDEX "conversion_batches_status_created_at_idx" ON "conversion_batches"("status", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "conversion_batches_subject_idempotency_key_key" ON "conversion_batches"("subject", "idempotency_key");

-- CreateIndex
CREATE UNIQUE INDEX "conversion_files_input_object_key_key" ON "conversion_files"("input_object_key");

-- CreateIndex
CREATE UNIQUE INDEX "conversion_files_output_object_key_key" ON "conversion_files"("output_object_key");

-- CreateIndex
CREATE INDEX "conversion_files_batch_id_created_at_idx" ON "conversion_files"("batch_id", "created_at");

-- CreateIndex
CREATE INDEX "conversion_files_status_created_at_idx" ON "conversion_files"("status", "created_at");

-- CreateIndex
CREATE INDEX "conversion_files_expires_at_idx" ON "conversion_files"("expires_at");

-- CreateIndex
CREATE INDEX "outbox_events_status_created_at_idx" ON "outbox_events"("status", "created_at");

-- AddForeignKey
ALTER TABLE "conversion_files" ADD CONSTRAINT "conversion_files_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "conversion_batches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "conversion_batches"
    ADD CONSTRAINT "conversion_batches_counts_check"
    CHECK ("file_count" > 0 AND "plan_revision" > 0);

ALTER TABLE "conversion_files"
    ADD CONSTRAINT "conversion_files_attempt_check"
    CHECK ("attempt" >= 0);

ALTER TABLE "daily_usage"
    ADD CONSTRAINT "daily_usage_admitted_files_check"
    CHECK ("admitted_files" >= 0);
