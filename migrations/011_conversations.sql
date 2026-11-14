CREATE TABLE conversations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 group_id uuid NOT NULL REFERENCES groups(id),
 actor_id text NOT NULL,
 generation bigint NOT NULL DEFAULT 1,
 runtime_generation bigint NOT NULL,
 last_interaction_at timestamptz NOT NULL,
 checkpoint_ciphertext text,
 checkpoint_sources uuid[] NOT NULL DEFAULT '{}',
 UNIQUE(group_id,actor_id)
);
CREATE TABLE search_jobs (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 conversation_id uuid NOT NULL REFERENCES conversations(id),
 conversation_generation bigint NOT NULL,
 runtime_generation bigint NOT NULL,
 request_ciphertext text,
 result_ciphertext text,
 source_ids uuid[] NOT NULL DEFAULT '{}',
 state text NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','running','ready','failed','cancelled')),
 created_at timestamptz NOT NULL,
 expires_at timestamptz NOT NULL,
 lease_until timestamptz,
 fence bigint NOT NULL DEFAULT 0,
 attempts integer NOT NULL DEFAULT 0
);
CREATE INDEX search_jobs_pending ON search_jobs(created_at) WHERE state IN ('queued','running');
ALTER TABLE interactions ADD COLUMN conversation_id uuid REFERENCES conversations(id);
ALTER TABLE interactions ADD COLUMN conversation_generation bigint;
ALTER TABLE deliveries ADD COLUMN conversation_id uuid REFERENCES conversations(id);
ALTER TABLE deliveries ADD COLUMN conversation_generation bigint;

ALTER TABLE deliveries ADD COLUMN search_result_id uuid REFERENCES search_jobs(id);
ALTER TABLE search_jobs ADD COLUMN excluded_source_id uuid REFERENCES sources(id);
