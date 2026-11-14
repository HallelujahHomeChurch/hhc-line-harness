CREATE TABLE source_indexes (
 source_id uuid PRIMARY KEY REFERENCES sources(id),
 source_revision bigint NOT NULL,
 runtime_generation bigint NOT NULL,
 extractor_version text NOT NULL,
 state text NOT NULL CHECK(state IN ('ready','incomplete','not_applicable','failed')),
 code text NOT NULL,
 extracted_text text NOT NULL DEFAULT '' CHECK(length(extracted_text)<=250000),
 terms text[] NOT NULL,
 indexed_at timestamptz NOT NULL
);
CREATE INDEX source_indexes_terms ON source_indexes USING gin(terms);
ALTER TABLE sources ADD COLUMN description text;
ALTER TABLE sources ADD COLUMN description_revision bigint NOT NULL DEFAULT 1;
CREATE TABLE source_relations (
 source_id uuid NOT NULL REFERENCES sources(id),
 related_source_id uuid NOT NULL REFERENCES sources(id),
 kind text NOT NULL CHECK(kind IN ('quoted','version')),
 confidence double precision NOT NULL DEFAULT 0 CHECK(confidence>=0 AND confidence<=1),
 status text NOT NULL DEFAULT 'candidate' CHECK(status IN ('candidate','confirmed')),
 evidence_source_id uuid NOT NULL REFERENCES sources(id),
 PRIMARY KEY(source_id,related_source_id,kind),
 CHECK(source_id<>related_source_id)
);
