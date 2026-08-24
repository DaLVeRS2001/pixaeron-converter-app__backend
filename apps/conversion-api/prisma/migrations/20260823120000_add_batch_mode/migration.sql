CREATE TYPE "ConversionMode" AS ENUM ('LOSSLESS', 'LOSSY');

ALTER TABLE "conversion_batches"
    ADD COLUMN "mode" "ConversionMode" NOT NULL DEFAULT 'LOSSY';
