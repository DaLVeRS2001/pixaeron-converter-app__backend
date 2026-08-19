ALTER TABLE "plans"
    DROP CONSTRAINT "plans_output_retention_hours_known";

UPDATE "plans"
    SET "output_retention_hours" = 96,
        "max_file_bytes" = 52428800
    WHERE "code" = 'LIGHT';

ALTER TABLE "plans"
    ADD CONSTRAINT "plans_output_retention_hours_known"
    CHECK ("output_retention_hours" IN (1, 48, 96, 168));
