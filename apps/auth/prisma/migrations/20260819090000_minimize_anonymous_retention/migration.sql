ALTER TABLE "plans"
    DROP CONSTRAINT "plans_output_retention_hours_known";

UPDATE "plans" SET "output_retention_hours" = 1 WHERE "code" = 'ANONYMOUS';

ALTER TABLE "plans"
    ADD CONSTRAINT "plans_output_retention_hours_known"
    CHECK ("output_retention_hours" IN (1, 48, 168));
