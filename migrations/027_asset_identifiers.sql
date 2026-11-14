-- Preserve external Asset identifiers exactly; only Harness and Account identities are UUIDs.
ALTER TABLE groups ALTER COLUMN collection_id TYPE text USING collection_id::text;
ALTER TABLE setup_intents ALTER COLUMN collection_id TYPE text USING collection_id::text;
ALTER TABLE collection_reservations ALTER COLUMN collection_id TYPE text USING collection_id::text;
ALTER TABLE sources ALTER COLUMN asset_id TYPE text USING asset_id::text, ALTER COLUMN publication_collection_id TYPE text USING publication_collection_id::text;
ALTER TABLE publications ALTER COLUMN collection_id TYPE text USING collection_id::text, ALTER COLUMN item_id TYPE text USING item_id::text;
ALTER TABLE orphan_assets ALTER COLUMN asset_id TYPE text USING asset_id::text;
ALTER TABLE collection_creations ALTER COLUMN collection_id TYPE text USING collection_id::text;
ALTER TABLE management_operations ALTER COLUMN collection_id TYPE text USING collection_id::text, ALTER COLUMN acl_id TYPE text USING acl_id::text;
