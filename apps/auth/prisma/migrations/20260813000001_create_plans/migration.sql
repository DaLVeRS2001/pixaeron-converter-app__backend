CREATE TABLE "plans" (
    "code" "PlanCode" NOT NULL,
    "revision" INTEGER NOT NULL,
    "effective_from" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "price_cents_monthly" INTEGER,
    "max_batch_files" INTEGER NOT NULL,
    "max_file_bytes" BIGINT NOT NULL,
    "daily_files" INTEGER,
    "max_concurrent_files" INTEGER NOT NULL,
    "queue_tier" INTEGER NOT NULL,
    "min_start_delay_ms" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "plans_pkey" PRIMARY KEY ("code","revision"),
    CONSTRAINT "plans_revision_positive_check" CHECK ("revision" > 0),
    CONSTRAINT "plans_limits_positive_check" CHECK (
        "max_batch_files" > 0
        AND "max_file_bytes" > 0
        AND "max_concurrent_files" > 0
        AND "queue_tier" >= 0
        AND "min_start_delay_ms" >= 0
        AND ("daily_files" IS NULL OR "daily_files" > 0)
        AND ("price_cents_monthly" IS NULL OR "price_cents_monthly" > 0)
    )
);

ALTER TABLE "users"
    ADD CONSTRAINT "users_plan_code_not_anonymous"
    CHECK ("plan_code" <> 'ANONYMOUS');

INSERT INTO "plans" (
    "code", "revision", "price_cents_monthly", "max_batch_files",
    "max_file_bytes", "daily_files", "max_concurrent_files",
    "queue_tier", "min_start_delay_ms"
) VALUES
    ('ANONYMOUS', 1, NULL, 3, 5242880,   10,   1, 0, 0),
    ('FREE',      1, NULL, 5, 10485760,  50,   1, 1, 0),
    ('LIGHT',     1, 225,  10, 78643200,  NULL, 3, 2, 0),
    ('PRO',       1, 1000, 20, 157286400, NULL, 8, 3, 0);
