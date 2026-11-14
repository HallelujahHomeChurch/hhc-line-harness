ALTER TABLE groups ADD COLUMN revocation_revision bigint NOT NULL DEFAULT 1 CHECK (revocation_revision > 0);
