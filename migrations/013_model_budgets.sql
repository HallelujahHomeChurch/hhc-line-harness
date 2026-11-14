CREATE TABLE model_runs (
 id uuid PRIMARY KEY,
 channel_id text NOT NULL,
 kind text NOT NULL CHECK(kind IN ('query','admin','index')),
 group_id uuid REFERENCES groups(id),
 actor_id text,
 runtime_generation bigint NOT NULL,
 state text NOT NULL DEFAULT 'running' CHECK(state IN ('running','completed','failed','cancelled')),
 created_at timestamptz NOT NULL,
 deadline timestamptz NOT NULL,
 calls integer NOT NULL DEFAULT 0,
 tools integer NOT NULL DEFAULT 0,
 used_tokens bigint NOT NULL DEFAULT 0 CHECK(used_tokens>=0),
 reserved_tokens bigint NOT NULL DEFAULT 0 CHECK(reserved_tokens>=0)
);
CREATE TABLE model_months (
 provider text NOT NULL CHECK(provider IN ('openai','azure')),
 month text NOT NULL CHECK(month ~ '^[0-9]{4}-[0-9]{2}$'),
 charged_micros bigint NOT NULL DEFAULT 0 CHECK(charged_micros>=0),
 reserved_micros bigint NOT NULL DEFAULT 0 CHECK(reserved_micros>=0),
 PRIMARY KEY(provider,month)
);
CREATE TABLE model_calls (
 id uuid PRIMARY KEY,
 run_id uuid NOT NULL REFERENCES model_runs(id),
 provider text NOT NULL,
 month text NOT NULL,
 model text NOT NULL,
 purpose text NOT NULL CHECK(purpose IN ('answer','embedding','summary')),
 state text NOT NULL DEFAULT 'started' CHECK(state IN ('started','unknown','settled')),
 price jsonb NOT NULL,
 input_limit integer NOT NULL,
 output_limit integer NOT NULL,
 reserved_micros bigint NOT NULL,
 actual_micros bigint,
 input_tokens integer,
 output_tokens integer,
 cached_input_tokens integer,
 cache_write_tokens integer,
 started_at timestamptz NOT NULL,
 settled_at timestamptz,
 FOREIGN KEY(provider,month) REFERENCES model_months(provider,month)
);
CREATE TABLE model_budget_alerts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 provider text NOT NULL,
 month text NOT NULL,
 kind text NOT NULL CHECK(kind IN ('azure_threshold','reservation_overrun')),
 created_at timestamptz NOT NULL,
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','delivered')),
 attempts integer NOT NULL DEFAULT 0,
 next_attempt_at timestamptz NOT NULL,
 UNIQUE(provider,month,kind)
);
