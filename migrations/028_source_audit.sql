-- LINE authors need not have an Account identity; never fabricate one for Audit.
ALTER TABLE audit_outbox ALTER COLUMN actor_user_id DROP NOT NULL;
