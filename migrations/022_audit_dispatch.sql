ALTER TABLE audit_outbox
 ADD COLUMN state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','delivered','dead_letter')),
 ADD COLUMN attempts integer NOT NULL DEFAULT 0,
 ADD COLUMN fence bigint NOT NULL DEFAULT 0,
 ADD COLUMN lease_until timestamptz,
 ADD COLUMN next_attempt_at timestamptz NOT NULL DEFAULT now(),
 ADD COLUMN error_code text,
 ADD COLUMN payload jsonb;
UPDATE audit_outbox SET state='delivered' WHERE delivered_at IS NOT NULL;
CREATE INDEX audit_outbox_pending ON audit_outbox(next_attempt_at) WHERE state='pending';
CREATE FUNCTION preserve_audit_fact() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (NEW.id,NEW.action,NEW.actor_user_id,NEW.target_id,NEW.target_revision,NEW.occurred_at)
 IS DISTINCT FROM (OLD.id,OLD.action,OLD.actor_user_id,OLD.target_id,OLD.target_revision,OLD.occurred_at)
 OR (OLD.payload IS NOT NULL AND NEW.payload IS DISTINCT FROM OLD.payload) THEN
  RAISE EXCEPTION 'audit_fact_immutable';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER preserve_audit_fact BEFORE UPDATE ON audit_outbox FOR EACH ROW EXECUTE FUNCTION preserve_audit_fact();
