ALTER TABLE deliveries ADD COLUMN actions jsonb;
CREATE TABLE interactions (
 id uuid PRIMARY KEY,
 sequence bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
 channel_id text NOT NULL,
 event_id text NOT NULL,
 actor_id text NOT NULL,
 scope_id text NOT NULL,
 runtime_generation bigint NOT NULL,
 kind text NOT NULL,
 payload_ciphertext text,
 delivery_id uuid REFERENCES deliveries(id),
 state text NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','running','completed','failed')),
 created_at timestamptz NOT NULL,
 expires_at timestamptz NOT NULL,
 lease_until timestamptz,
 fence bigint NOT NULL DEFAULT 0,
 UNIQUE(channel_id,event_id)
);
CREATE INDEX interactions_queue ON interactions(sequence) WHERE state='queued';
