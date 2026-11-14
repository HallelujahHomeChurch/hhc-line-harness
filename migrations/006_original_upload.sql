ALTER TABLE sources ADD COLUMN upload_state text NOT NULL DEFAULT 'none' CHECK(upload_state IN ('none','intent','created','completed'));
ALTER TABLE sources ADD COLUMN publication_collection_id uuid;
ALTER TABLE sources ADD COLUMN publication_acl_revision bigint;
ALTER TABLE sources ADD COLUMN publication_binding_generation bigint;
