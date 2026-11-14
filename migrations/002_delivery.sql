CREATE TABLE deliveries (
  id uuid PRIMARY KEY,
  channel_id text NOT NULL,
  event_id text NOT NULL,
  group_id uuid REFERENCES groups(id),
  group_revision bigint,
  runtime_generation bigint NOT NULL,
  token_ciphertext text,
  body text,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','attempt_reserved','delivered','unknown','expired','cancelled')),
  received_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  attempted_at timestamptz,
  finished_at timestamptz,
  UNIQUE(channel_id,event_id)
);
CREATE INDEX deliveries_pending ON deliveries(received_at) WHERE state='pending';
