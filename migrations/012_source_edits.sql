CREATE TABLE source_edits (
 id uuid PRIMARY KEY,
 group_id uuid NOT NULL REFERENCES groups(id),
 source_id uuid NOT NULL REFERENCES sources(id),
 actor_id text NOT NULL,
 conversation_id uuid NOT NULL REFERENCES conversations(id),
 conversation_generation bigint NOT NULL,
 runtime_generation bigint NOT NULL,
 group_revision bigint NOT NULL,
 source_revision bigint NOT NULL,
 description_revision bigint NOT NULL,
 authority jsonb NOT NULL,
 kind text NOT NULL CHECK(kind IN ('description','delete')),
 text_ciphertext text,
 confirmation_hash text NOT NULL,
 expires_at timestamptz NOT NULL,
 state text NOT NULL DEFAULT 'preview' CHECK(state IN ('preview','completed','cancelled'))
);
