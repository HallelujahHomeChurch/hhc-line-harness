ALTER TABLE runtime_state ADD COLUMN installation_id uuid NOT NULL DEFAULT gen_random_uuid();
CREATE TABLE recovery_records (
 generation bigint PRIMARY KEY,
 journal_signature text NOT NULL UNIQUE,
 journal_as_of timestamptz NOT NULL,
 restored_at timestamptz NOT NULL,
 reconciled_at timestamptz,
 admitted_at timestamptz
);
ALTER TABLE model_calls ADD COLUMN settlement_fenced boolean NOT NULL DEFAULT false;
