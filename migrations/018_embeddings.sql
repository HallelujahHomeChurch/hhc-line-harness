SELECT pg_advisory_xact_lock(hashtextextended('harness:vector-extension',0));
CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public;
CREATE TABLE embedding_versions (
 id text PRIMARY KEY,
 channel_id text NOT NULL,
 provider text NOT NULL CHECK(provider IN ('openai','azure')),
 model text NOT NULL,
 response_model text NOT NULL,
 dimensions integer NOT NULL CHECK(dimensions BETWEEN 1 AND 2000),
 chunker text NOT NULL,
 state text NOT NULL DEFAULT 'building' CHECK(state IN ('building','active','retired')),
 evaluation jsonb,
 created_at timestamptz NOT NULL,
 UNIQUE(id,dimensions)
);
CREATE UNIQUE INDEX embedding_active_channel ON embedding_versions(channel_id) WHERE state='active';
CREATE TABLE embedding_documents (
 source_id uuid NOT NULL REFERENCES sources(id),
 version text NOT NULL REFERENCES embedding_versions(id),
 source_revision bigint NOT NULL,
 description_revision bigint NOT NULL,
 runtime_generation bigint NOT NULL,
 text_hash text NOT NULL,
 state text NOT NULL CHECK(state IN ('queued','processing','ready')),
 next_chunk integer NOT NULL DEFAULT 0,
 available_at timestamptz NOT NULL,
 lease_until timestamptz,
 fence bigint NOT NULL DEFAULT 0,
 PRIMARY KEY(source_id,version)
);
CREATE TABLE source_vectors (
 source_id uuid NOT NULL,
 version text NOT NULL,
 dimensions integer NOT NULL,
 ordinal integer NOT NULL,
 embedding public.vector NOT NULL,
 PRIMARY KEY(source_id,version,ordinal),
 FOREIGN KEY(source_id,version) REFERENCES embedding_documents(source_id,version) ON DELETE CASCADE,
 FOREIGN KEY(version,dimensions) REFERENCES embedding_versions(id,dimensions),
 CHECK(vector_dims(embedding)=dimensions)
);
