ALTER TABLE model_calls ADD COLUMN cache_write_long_tokens integer NOT NULL DEFAULT 0 CHECK(cache_write_long_tokens>=0);
