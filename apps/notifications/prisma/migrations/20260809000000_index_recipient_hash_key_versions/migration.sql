-- CreateIndex
CREATE INDEX "email_deliveries_recipient_hash_key_version_idx"
ON "email_deliveries"("recipient_hash_key_version");

-- CreateIndex
CREATE INDEX "email_destinations_recipient_hash_key_version_idx"
ON "email_destinations"("recipient_hash_key_version");
