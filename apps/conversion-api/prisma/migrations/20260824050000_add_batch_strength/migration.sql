CREATE TYPE "ConversionStrength" AS ENUM ('LOW', 'MEDIUM', 'HIGH');

ALTER TABLE "conversion_batches"
    ADD COLUMN "strength" "ConversionStrength" NOT NULL DEFAULT 'LOW';
