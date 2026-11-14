ALTER TABLE sources ADD COLUMN asset_source_revision uuid NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE sources ADD COLUMN asset_id uuid;
ALTER TABLE sources ADD COLUMN asset_etag text;
ALTER TABLE sources ADD COLUMN mime_type text;
ALTER TABLE sources ADD COLUMN checksum_sha256 text;
ALTER TABLE sources ADD COLUMN upload_file_name text;
CREATE TABLE source_tombstones (
 source_key text PRIMARY KEY,
 revoked_at timestamptz NOT NULL,
 expires_at timestamptz NOT NULL
);
CREATE INDEX source_tombstones_expiry ON source_tombstones(expires_at);
CREATE FUNCTION immutable_source() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (NEW.group_id,NEW.message_id,NEW.published_at,NEW.expires_at,NEW.asset_source_revision) IS DISTINCT FROM (OLD.group_id,OLD.message_id,OLD.published_at,OLD.expires_at,OLD.asset_source_revision) THEN RAISE EXCEPTION 'source identity is immutable'; END IF;
 IF OLD.state IN ('revoked','expired') AND NEW.state NOT IN ('revoked','expired') THEN RAISE EXCEPTION 'source cannot revive'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER immutable_source BEFORE UPDATE ON sources FOR EACH ROW EXECUTE FUNCTION immutable_source();
ALTER TABLE jobs DROP CONSTRAINT jobs_kind_check;
ALTER TABLE jobs ADD CONSTRAINT jobs_kind_check CHECK(kind IN ('download','index','publish','cleanup'));
ALTER TABLE jobs ADD COLUMN available_at timestamptz NOT NULL DEFAULT clock_timestamp();
ALTER TABLE jobs ADD COLUMN deadline timestamptz;
ALTER TABLE jobs ADD COLUMN lease_until timestamptz;
ALTER TABLE jobs ADD COLUMN fence bigint NOT NULL DEFAULT 0;
ALTER TABLE jobs ADD COLUMN attempts integer NOT NULL DEFAULT 0;
ALTER TABLE jobs ADD COLUMN failure_code text;
CREATE INDEX jobs_queue ON jobs(kind,available_at,created_at) WHERE state IN ('queued','retry_wait','leased');
CREATE TABLE publications (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 source_id uuid NOT NULL REFERENCES sources(id),
 collection_id uuid NOT NULL,
 item_id uuid,
 source_revision bigint NOT NULL,
 group_revision bigint NOT NULL,
 acl_revision bigint NOT NULL,
 binding_generation bigint NOT NULL,
 state text NOT NULL DEFAULT 'intent' CHECK(state IN ('intent','staged','approved','active','revoked')),
 created_at timestamptz NOT NULL,
 UNIQUE(source_id,collection_id,binding_generation)
);
CREATE TABLE orphan_assets (
 asset_id uuid PRIMARY KEY,
 source_id uuid NOT NULL REFERENCES sources(id),
 created_at timestamptz NOT NULL,
 removed_at timestamptz
);
