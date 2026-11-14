CREATE TABLE management_operations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 group_id uuid NOT NULL REFERENCES groups(id),
 actor_user_id uuid NOT NULL,
 admin_authorization_revision bigint NOT NULL,
 account_binding_generation bigint,
 runtime_generation bigint NOT NULL,
 group_revision bigint NOT NULL,
 action text NOT NULL CHECK(action IN ('pause','delete','acl_revoke')),
 confirmation_hash text NOT NULL,
 expires_at timestamptz NOT NULL,
 state text NOT NULL DEFAULT 'preview' CHECK(state IN ('preview','applying','completed'))
);
-- Old reservations remain until unknown publications are resolved; only one destination is active in groups.
ALTER TABLE collection_reservations DROP CONSTRAINT collection_reservations_group_id_key;
CREATE TABLE collection_creations (
 id uuid PRIMARY KEY,
 actor_user_id uuid NOT NULL,
 name text NOT NULL,
 collection_id uuid,
 created_at timestamptz NOT NULL
);
ALTER TABLE groups ADD COLUMN display_name text NOT NULL DEFAULT 'LINE 群組';

ALTER TABLE setup_intents ADD COLUMN add_reader jsonb;

ALTER TABLE management_operations
 ADD COLUMN collection_id uuid,
 ADD COLUMN acl_id uuid,
 ADD COLUMN acl_revision bigint,
 ADD COLUMN binding_generation bigint,
 ADD COLUMN previous_sharing boolean,
 ADD COLUMN audience jsonb;
