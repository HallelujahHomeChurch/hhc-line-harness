ALTER TABLE model_runs ADD COLUMN source_ids uuid[] NOT NULL DEFAULT '{}';
CREATE INDEX model_runs_sources ON model_runs USING gin(source_ids);
