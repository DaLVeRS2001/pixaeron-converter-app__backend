-- CreateEnum
CREATE TYPE "SessionRevokedReason" AS ENUM ('LOGOUT', 'LOGOUT_ALL', 'REFRESH_REUSE', 'PASSWORD_CHANGED', 'EXPIRED', 'ADMIN_REVOKED', 'SECURITY_RISK');

-- CreateEnum
CREATE TYPE "SessionEventType" AS ENUM ('LOGIN_SUCCESS', 'LOGIN_FAILED', 'REGISTER_SUCCESS', 'REFRESH_SUCCESS', 'REFRESH_FAILED', 'REFRESH_REUSE_DETECTED', 'LOGOUT', 'LOGOUT_ALL', 'SESSION_EXPIRED', 'PASSWORD_CHANGED', 'SUSPICIOUS_IP', 'SUSPICIOUS_USER_AGENT');

-- CreateTable
CREATE TABLE "sessions" (
    "id" TEXT NOT NULL,
    "user_id" INTEGER NOT NULL,
    "refresh_token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "revoked_at" TIMESTAMP(3),
    "revoked_reason" "SessionRevokedReason",
    "last_used_at" TIMESTAMP(3),
    "rotated_at" TIMESTAMP(3),
    "remember_me" BOOLEAN NOT NULL DEFAULT false,
    "user_agent" TEXT,
    "ip_hash" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "session_events" (
    "id" TEXT NOT NULL,
    "session_id" TEXT,
    "user_id" INTEGER,
    "type" "SessionEventType" NOT NULL,
    "ip_hash" TEXT,
    "user_agent" TEXT,
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "session_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "sessions_user_id_idx" ON "sessions"("user_id");

-- CreateIndex
CREATE INDEX "sessions_expires_at_idx" ON "sessions"("expires_at");

-- CreateIndex
CREATE INDEX "sessions_revoked_at_idx" ON "sessions"("revoked_at");

-- CreateIndex
CREATE INDEX "session_events_session_id_idx" ON "session_events"("session_id");

-- CreateIndex
CREATE INDEX "session_events_user_id_idx" ON "session_events"("user_id");

-- CreateIndex
CREATE INDEX "session_events_type_idx" ON "session_events"("type");

-- CreateIndex
CREATE INDEX "session_events_created_at_idx" ON "session_events"("created_at");

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "session_events" ADD CONSTRAINT "session_events_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "sessions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "session_events" ADD CONSTRAINT "session_events_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
