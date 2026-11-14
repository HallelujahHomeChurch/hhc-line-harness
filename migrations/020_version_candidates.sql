ALTER TABLE source_relations ADD COLUMN evidence_quote text,
 ADD COLUMN producer text NOT NULL DEFAULT 'explicit' CHECK(producer IN ('explicit','model')),
 ADD COLUMN model_run_id uuid REFERENCES model_runs(id) ON DELETE SET NULL,
 ADD CHECK(producer<>'model' OR status='candidate');
