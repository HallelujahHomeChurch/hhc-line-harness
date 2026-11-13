CREATE TABLE legacy_handoffs (
 channel_id text PRIMARY KEY,
 manifest_digest text NOT NULL,
 state text NOT NULL DEFAULT 'prepared' CHECK(state IN ('prepared','frozen','active')),
 generation bigint NOT NULL,
 evidence jsonb NOT NULL DEFAULT '{}'
);
CREATE TABLE legacy_sources (
 id uuid PRIMARY KEY,
 channel_id text NOT NULL REFERENCES legacy_handoffs(channel_id),
 manifest jsonb NOT NULL,
 state text NOT NULL CHECK(state IN ('active','revoked','expired')),
 revision bigint NOT NULL DEFAULT 1,
 group_blocked boolean NOT NULL DEFAULT false,
 cleanup_state text NOT NULL CHECK(cleanup_state IN ('not_required','pending','completed')),
 reconciliations jsonb NOT NULL DEFAULT '{}',
 cleanup_receipt text
);

CREATE UNIQUE INDEX legacy_source_identity ON legacy_sources(channel_id,(manifest->>'profile'),(manifest->>'sourceKey'));
CREATE INDEX legacy_message ON legacy_sources(channel_id,(manifest->>'groupId'),(manifest->>'messageId'));
CREATE FUNCTION guard_legacy_source() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.manifest IS DISTINCT FROM OLD.manifest OR NEW.id<>OLD.id OR NEW.channel_id<>OLD.channel_id THEN RAISE EXCEPTION 'immutable legacy manifest'; END IF;
 IF OLD.state<>'active' AND NEW.state='active' THEN RAISE EXCEPTION 'terminal legacy source'; END IF;
 IF NEW.revision<OLD.revision THEN RAISE EXCEPTION 'legacy revision decreased'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER guard_legacy_source BEFORE UPDATE ON legacy_sources FOR EACH ROW EXECUTE FUNCTION guard_legacy_source();
CREATE FUNCTION guard_legacy_admission() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.mode='open' AND EXISTS(SELECT 1 FROM legacy_handoffs WHERE state<>'active' OR generation<>NEW.generation) THEN RAISE EXCEPTION 'legacy handoff incomplete'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER guard_legacy_admission BEFORE UPDATE ON runtime_state FOR EACH ROW EXECUTE FUNCTION guard_legacy_admission();
