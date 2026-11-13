CREATE TABLE admin_conversations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 channel_id text NOT NULL,
 actor_id text NOT NULL,
 generation bigint NOT NULL DEFAULT 1,
 runtime_generation bigint NOT NULL,
 last_interaction_at timestamptz NOT NULL,
 UNIQUE(channel_id,actor_id)
);
CREATE TABLE admin_queries (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 conversation_id uuid NOT NULL REFERENCES admin_conversations(id),
 conversation_generation bigint NOT NULL,
 runtime_generation bigint NOT NULL,
 authority jsonb NOT NULL,
 query_ciphertext text,
 result_ciphertext text,
 state text NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','running','ready','failed','cancelled')),
 created_at timestamptz NOT NULL,
 expires_at timestamptz NOT NULL,
 lease_until timestamptz,
 fence bigint NOT NULL DEFAULT 0
);
CREATE INDEX admin_queries_pending ON admin_queries(created_at,id) WHERE state IN ('queued','running');
ALTER TABLE deliveries ADD COLUMN admin_conversation_id uuid REFERENCES admin_conversations(id), ADD COLUMN admin_conversation_generation bigint, ADD COLUMN admin_query_id uuid REFERENCES admin_queries(id);
