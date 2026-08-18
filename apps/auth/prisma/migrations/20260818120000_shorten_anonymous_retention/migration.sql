ALTER TABLE "plans"
    DROP CONSTRAINT "plans_output_retention_hours_known";

ALTER TABLE "plans"
    ADD CONSTRAINT "plans_output_retention_hours_known"
    CHECK ("output_retention_hours" IN (4, 48, 168));

UPDATE "plans" SET "output_retention_hours" = 4 WHERE "code" = 'ANONYMOUS';
