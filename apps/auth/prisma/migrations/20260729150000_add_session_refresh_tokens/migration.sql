BEGIN;

CREATE TABLE "session_refresh_tokens" (
    "id" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "secret_hash" TEXT NOT NULL,
    "consumed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "session_refresh_tokens_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "session_refresh_tokens"
ADD CONSTRAINT "session_refresh_tokens_session_id_fkey"
FOREIGN KEY ("session_id") REFERENCES "sessions"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

INSERT INTO "session_refresh_tokens" (
    "id",
    "session_id",
    "secret_hash",
    "created_at"
)
SELECT
    "id",
    "id",
    "refresh_token_hash",
    COALESCE("rotated_at", "created_at")
FROM "sessions";

CREATE INDEX "session_refresh_tokens_session_id_idx"
ON "session_refresh_tokens"("session_id");

COMMIT;