ALTER TABLE deliveries ADD COLUMN actor_id text;
ALTER TABLE deliveries ADD COLUMN scope_id text;
ALTER TABLE groups ADD COLUMN sharing_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE groups ADD COLUMN collection_id uuid;
ALTER TABLE groups ADD COLUMN acl_revision bigint;
ALTER TABLE groups ADD COLUMN binding_generation bigint;
CREATE TABLE setup_intents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id uuid NOT NULL REFERENCES groups(id),
  line_actor_id text NOT NULL,
  account_actor_id uuid,
  account_binding_generation bigint,
  admin_authorization_revision bigint,
  runtime_generation bigint NOT NULL,
  group_revision bigint NOT NULL,
  revision bigint NOT NULL DEFAULT 1,
  sharing_enabled boolean NOT NULL DEFAULT false,
  collection_id uuid,
  acl_revision bigint,
  binding_generation bigint,
  audience jsonb,
  state text NOT NULL DEFAULT 'bootstrap' CHECK (state IN ('bootstrap','draft','preview','announcing','active','unknown')),
  expires_at timestamptz NOT NULL,
  confirmation_hash text,
  confirmation_expires_at timestamptz,
  delivery_id uuid REFERENCES deliveries(id),
  UNIQUE(delivery_id)
);
CREATE TABLE collection_reservations (
  collection_id uuid PRIMARY KEY,
  group_id uuid NOT NULL UNIQUE REFERENCES groups(id),
  binding_generation bigint NOT NULL,
  reserved_at timestamptz NOT NULL
);
CREATE TABLE audit_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  action text NOT NULL,
  actor_user_id uuid NOT NULL,
  target_id uuid NOT NULL,
  target_revision bigint NOT NULL,
  occurred_at timestamptz NOT NULL,
  delivered_at timestamptz
);
