ALTER TABLE admin_conversations ADD COLUMN last_result_id uuid REFERENCES admin_queries(id);
ALTER TABLE admin_queries ADD COLUMN sequence bigint GENERATED ALWAYS AS IDENTITY UNIQUE;
ALTER TABLE search_jobs ADD COLUMN sequence bigint GENERATED ALWAYS AS IDENTITY UNIQUE;
