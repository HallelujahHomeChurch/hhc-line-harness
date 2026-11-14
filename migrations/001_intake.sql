CREATE TABLE runtime_state (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  mode text NOT NULL DEFAULT 'closed' CHECK (mode IN ('closed','open','restoring')),
  generation bigint NOT NULL DEFAULT 1 CHECK (generation > 0),
  ingest_floor timestamptz NOT NULL DEFAULT clock_timestamp()
);
INSERT INTO runtime_state DEFAULT VALUES;

CREATE TABLE groups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id text NOT NULL,
  line_group_id text NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','active','paused','left','deleting','deleted')),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  active_from timestamptz,
  UNIQUE(channel_id,line_group_id),
  CHECK (state <> 'active' OR active_from IS NOT NULL)
);

CREATE TABLE event_receipts (
  channel_id text NOT NULL,
  event_id text NOT NULL,
  scope text NOT NULL,
  event_type text NOT NULL,
  published_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  outcome text NOT NULL DEFAULT 'ignored',
  PRIMARY KEY(channel_id,event_id)
);
CREATE INDEX event_receipts_expiry ON event_receipts(expires_at);

CREATE TABLE sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id uuid NOT NULL REFERENCES groups(id),
  message_id text NOT NULL,
  author_id text,
  kind text NOT NULL,
  body text,
  file_name text,
  byte_size bigint,
  published_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  state text NOT NULL CHECK (state IN ('queued','ready','held','revoked','expired','failed')),
  UNIQUE(group_id,message_id),
  CHECK (expires_at = published_at + interval '2160 hours')
);
CREATE INDEX sources_expiry ON sources(expires_at);

CREATE TABLE jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id uuid NOT NULL REFERENCES sources(id),
  kind text NOT NULL CHECK (kind IN ('download','index')),
  state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','leased','retry_wait','held','completed','failed','cancelled')),
  runtime_generation bigint NOT NULL,
  source_revision bigint NOT NULL,
  created_at timestamptz NOT NULL,
  UNIQUE(source_id,kind)
);
CREATE TABLE job_wakes (
  job_id uuid PRIMARY KEY REFERENCES jobs(id),
  created_at timestamptz NOT NULL,
  delivered_at timestamptz
);
