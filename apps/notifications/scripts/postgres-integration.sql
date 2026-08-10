BEGIN;

INSERT INTO "email_deliveries" (
  "id", "request_id", "public_subject", "recipient_hash",
  "recipient_hash_key_version", "purpose", "content_version",
  "token_fingerprint", "status", "caller_result", "updated_at"
) VALUES (
  '10000000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000002',
  '10000000-0000-4000-8000-000000000003',
  repeat('a', 64), 1, 'EMAIL_VERIFICATION', 1, repeat('d', 64),
  'ACCEPTED', 'ACCEPTED', CURRENT_TIMESTAMP
);

DO $$
BEGIN
  BEGIN
    UPDATE "email_deliveries"
    SET "attempt_count" = 2
    WHERE "id" = '10000000-0000-4000-8000-000000000001';
    RAISE EXCEPTION 'single-attempt constraint was not enforced';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  BEGIN
    UPDATE "email_deliveries"
    SET "caller_result" = 'FAILED'
    WHERE "id" = '10000000-0000-4000-8000-000000000001';
    RAISE EXCEPTION 'caller_result immutability was not enforced';
  EXCEPTION WHEN SQLSTATE '55000' THEN NULL;
  END;
END;
$$;

INSERT INTO "email_delivery_events" (
  "id", "delivery_id", "event_type", "provider_message_id",
  "semantic_fingerprint", "occurred_at"
) VALUES (
  '20000000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000001',
  'SEND', 'integration-provider-message', repeat('b', 64), CURRENT_TIMESTAMP
);

DO $$
BEGIN
  BEGIN
    UPDATE "email_delivery_events"
    SET "subtype" = 'rewritten'
    WHERE "id" = '20000000-0000-4000-8000-000000000001';
    RAISE EXCEPTION 'delivery event append-only trigger was not enforced';
  EXCEPTION WHEN SQLSTATE '55000' THEN NULL;
  END;
END;
$$;

INSERT INTO "email_destinations" (
  "id", "recipient_hash", "recipient_hash_key_version", "status",
  "suppression_revision", "updated_at"
) VALUES (
  '30000000-0000-4000-8000-000000000001',
  repeat('c', 64), 1, 'SUPPRESSED', 1, CURRENT_TIMESTAMP
);

INSERT INTO "email_recovery_audits" (
  "id", "destination_id", "operation_id", "action", "actor_id", "reason_code",
  "evidence_reference", "previous_status", "next_status",
  "suppression_revision"
) VALUES (
  '40000000-0000-4000-8000-000000000001',
  '30000000-0000-4000-8000-000000000001',
  '40000000-0000-4000-8000-000000000002',
  'REQUESTED', 'integration-test', 'INTEGRATION_TEST', 'integration-test',
  'SUPPRESSED', 'RECOVERY_PENDING', 1
);

DO $$
BEGIN
  BEGIN
    UPDATE "email_recovery_audits"
    SET "reason_code" = 'REWRITTEN'
    WHERE "id" = '40000000-0000-4000-8000-000000000001';
    RAISE EXCEPTION 'recovery audit append-only trigger was not enforced';
  EXCEPTION WHEN SQLSTATE '55000' THEN NULL;
  END;

  BEGIN
    INSERT INTO "email_recovery_audits" (
      "id", "destination_id", "operation_id", "action", "actor_id",
      "reason_code", "evidence_reference", "previous_status", "next_status",
      "suppression_revision"
    ) VALUES (
      '40000000-0000-4000-8000-000000000003',
      '30000000-0000-4000-8000-000000000001',
      '40000000-0000-4000-8000-000000000002',
      'REQUESTED', 'integration-test', 'INTEGRATION_TEST', 'integration-test',
      'SUPPRESSED', 'RECOVERY_PENDING', 1
    );
    RAISE EXCEPTION 'recovery operation uniqueness was not enforced';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;

  BEGIN
    INSERT INTO "email_recovery_audits" (
      "id", "destination_id", "operation_id", "action", "actor_id",
      "reason_code", "evidence_reference", "previous_status", "next_status",
      "suppression_revision"
    ) VALUES (
      '40000000-0000-4000-8000-000000000004',
      '30000000-0000-4000-8000-000000000001',
      '40000000-0000-4000-8000-000000000005',
      'REQUESTED', 'integration-test', 'INTEGRATION_TEST', 'integration-test',
      'SUPPRESSED', 'RECOVERY_PENDING', -1
    );
    RAISE EXCEPTION 'recovery revision constraint was not enforced';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END;
$$;

ROLLBACK;