ALTER TABLE "User" RENAME TO "users";

ALTER TABLE "users" RENAME CONSTRAINT "User_pkey" TO "users_pkey";

ALTER TABLE "users" RENAME CONSTRAINT "User_legal_consent_pair_check" TO "users_legal_consent_pair_check";

ALTER INDEX "User_email_key" RENAME TO "users_email_key";

ALTER INDEX "User_public_id_key" RENAME TO "users_public_id_key";

ALTER SEQUENCE "User_id_seq" RENAME TO "users_id_seq";
