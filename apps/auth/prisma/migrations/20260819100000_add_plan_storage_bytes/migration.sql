ALTER TABLE "plans" ADD COLUMN "storage_bytes" BIGINT;

UPDATE "plans" SET "storage_bytes" = 1073741824  WHERE "code" = 'FREE';
UPDATE "plans" SET "storage_bytes" = 2147483648  WHERE "code" = 'LIGHT';
UPDATE "plans" SET "storage_bytes" = 10737418240 WHERE "code" = 'PRO';

ALTER TABLE "plans"
    ADD CONSTRAINT "plans_storage_bytes_positive_check"
    CHECK ("storage_bytes" IS NULL OR "storage_bytes" > 0);
