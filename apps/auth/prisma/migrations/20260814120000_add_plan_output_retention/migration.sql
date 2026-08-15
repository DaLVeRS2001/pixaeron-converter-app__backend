ALTER TABLE "plans"
    ADD COLUMN "output_retention_hours" INTEGER NOT NULL DEFAULT 48;

ALTER TABLE "plans"
    ALTER COLUMN "output_retention_hours" DROP DEFAULT;

ALTER TABLE "plans"
    ADD CONSTRAINT "plans_output_retention_hours_known"
    CHECK ("output_retention_hours" IN (48, 168));

UPDATE "plans"
SET "output_retention_hours" = 168
WHERE "code" IN ('LIGHT', 'PRO');
