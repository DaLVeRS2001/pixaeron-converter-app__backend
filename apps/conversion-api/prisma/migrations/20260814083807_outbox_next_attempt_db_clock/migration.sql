-- AlterTable
ALTER TABLE "outbox_events" ALTER COLUMN "next_attempt_at" SET DEFAULT CURRENT_TIMESTAMP;
