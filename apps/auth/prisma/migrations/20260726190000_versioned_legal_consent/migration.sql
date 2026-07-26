-- Existing accounts intentionally remain NULL until a future explicit re-consent flow.
ALTER TABLE "User"
ADD COLUMN "legal_consent_version" TEXT,
ADD COLUMN "legal_consent_accepted_at" TIMESTAMP(3);

ALTER TABLE "User"
ADD CONSTRAINT "User_legal_consent_pair_check"
CHECK (
  (
    "legal_consent_version" IS NULL
    AND "legal_consent_accepted_at" IS NULL
  )
  OR
  (
    "legal_consent_version" IS NOT NULL
    AND "legal_consent_accepted_at" IS NOT NULL
  )
);
