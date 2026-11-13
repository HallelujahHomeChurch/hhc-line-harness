ALTER TABLE model_runs ADD COLUMN provider text NOT NULL DEFAULT 'openai' CHECK(provider IN ('openai','azure'));
CREATE TABLE model_steps (
 run_id uuid NOT NULL REFERENCES model_runs(id),
 ordinal integer NOT NULL CHECK(ordinal>=0),
 request_hash text NOT NULL,
 state text NOT NULL CHECK(state IN ('started','completed')),
 response_ciphertext text,
 PRIMARY KEY(run_id,ordinal)
);
CREATE TABLE agent_tools (
 run_id uuid NOT NULL REFERENCES model_runs(id),
 key text NOT NULL,
 name text NOT NULL,
 arguments_ciphertext text NOT NULL,
 result_ciphertext text,
 state text NOT NULL CHECK(state IN ('started','completed')),
 PRIMARY KEY(run_id,key)
);
