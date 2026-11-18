-- Additive: rollback images can ignore these tables. Never backfill delivery proof.
ALTER TABLE deliveries ADD COLUMN turn_ciphertext text;
ALTER TABLE deliveries ADD COLUMN quote_token_ciphertext text;
ALTER TABLE search_jobs ADD COLUMN turn_request jsonb;
ALTER TABLE sources ADD COLUMN quoted_message_id text;
ALTER TABLE sources ADD COLUMN event_id text;
ALTER TABLE sources ADD COLUMN conversation_signal text;
CREATE TABLE group_turns (
 id uuid PRIMARY KEY, -- Delivery proof is atomic; receipt cleanup must not delete public history.
 group_id uuid NOT NULL REFERENCES groups(id),
 actor_id text NOT NULL,
 group_revision bigint NOT NULL,
 runtime_generation bigint NOT NULL,
 message_id text NOT NULL,
 event_at timestamptz NOT NULL,
 event_id text NOT NULL DEFAULT '',
 delivered_at timestamptz NOT NULL,
 line_message_ids text[] NOT NULL CHECK(cardinality(line_message_ids) BETWEEN 1 AND 5),
 question_ciphertext text,
 answer_ciphertext text,
 kind text NOT NULL CHECK(kind IN ('answer','clarification')),
 follow_up text NOT NULL CHECK(follow_up IN ('continue','awaiting','closed')),
 dependencies jsonb NOT NULL,
 source_ids uuid[] NOT NULL DEFAULT '{}',
 expires_at timestamptz NOT NULL,
 consumed_by uuid,
 claimed_by uuid,
 version bigint NOT NULL DEFAULT 1
);
CREATE INDEX group_turns_recent ON group_turns(group_id,event_at DESC,delivered_at DESC);
CREATE INDEX group_turns_messages ON group_turns USING gin(line_message_ids);
CREATE INDEX group_turns_sources ON group_turns USING gin(source_ids);
CREATE TABLE group_turn_resets (
 group_id uuid NOT NULL REFERENCES groups(id),
 actor_id text NOT NULL,
 closed_at timestamptz NOT NULL,
 closed_event_id text NOT NULL DEFAULT '',
 PRIMARY KEY(group_id,actor_id)
);

ALTER TABLE interactions ADD COLUMN published_at timestamptz;
ALTER TABLE interactions ADD COLUMN reply_kind text;
ALTER TABLE interactions ADD COLUMN routing_reason text;
ALTER TABLE interactions ADD COLUMN finished_at timestamptz;
