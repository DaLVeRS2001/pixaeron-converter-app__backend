ALTER TYPE "SessionEventType" ADD VALUE 'EMAIL_VERIFICATION_ACCEPTED';
ALTER TYPE "SessionEventType" ADD VALUE 'PASSWORD_RESET_ACCEPTED';

WITH ranked_tokens AS (
    SELECT
        "id",
        ROW_NUMBER() OVER (
            PARTITION BY "user_id", "type"
            ORDER BY "created_at" DESC, "id" DESC
        ) AS position
    FROM "auth_tokens"
    WHERE "consumed_at" IS NULL
)
UPDATE "auth_tokens"
SET "consumed_at" = CURRENT_TIMESTAMP
FROM ranked_tokens
WHERE "auth_tokens"."id" = ranked_tokens."id"
  AND ranked_tokens.position > 1;

CREATE UNIQUE INDEX "auth_tokens_one_active_per_user_type"
ON "auth_tokens" ("user_id", "type")
WHERE "consumed_at" IS NULL;