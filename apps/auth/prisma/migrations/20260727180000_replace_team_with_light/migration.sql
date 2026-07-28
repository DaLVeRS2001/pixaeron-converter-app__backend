ALTER TYPE "PlanCode" RENAME TO "PlanCode_old";
CREATE TYPE "PlanCode" AS ENUM ('FREE', 'LIGHT', 'PRO');

ALTER TABLE "User" ALTER COLUMN "plan_code" DROP DEFAULT;
ALTER TABLE "User" ALTER COLUMN "plan_code" TYPE "PlanCode"
USING (
  CASE WHEN "plan_code"::text = 'TEAM' THEN 'PRO'
       ELSE "plan_code"::text
  END
)::"PlanCode";
ALTER TABLE "User" ALTER COLUMN "plan_code" SET DEFAULT 'FREE';

DROP TYPE "PlanCode_old";