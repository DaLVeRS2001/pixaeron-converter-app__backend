BEGIN;

ALTER TABLE "User" ADD COLUMN "public_id" UUID;

UPDATE "User"
SET "public_id" = gen_random_uuid()
WHERE "public_id" IS NULL;

ALTER TABLE "User"
  ALTER COLUMN "public_id" SET DEFAULT gen_random_uuid(),
  ALTER COLUMN "public_id" SET NOT NULL;

CREATE UNIQUE INDEX "User_public_id_key" ON "User"("public_id");

COMMIT;
