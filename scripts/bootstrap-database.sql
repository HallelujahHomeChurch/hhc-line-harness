\set ON_ERROR_STOP on
\getenv api_password HARNESS_API_DB_PASSWORD
\getenv worker_password HARNESS_WORKER_DB_PASSWORD
\getenv migrate_password HARNESS_MIGRATE_DB_PASSWORD
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
DO $$ BEGIN
  IF current_database() <> 'hhc_line_harness' THEN
    RAISE EXCEPTION 'wrong_bootstrap_database';
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname IN
      ('hhc_line_harness_api','hhc_line_harness_worker','hhc_line_harness_migrate')) THEN
    RAISE EXCEPTION 'existing_roles_require_reconciliation';
  END IF;
END $$;
CREATE ROLE hhc_line_harness_api LOGIN PASSWORD :'api_password'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 16;
CREATE ROLE hhc_line_harness_worker LOGIN PASSWORD :'worker_password'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 3;
CREATE ROLE hhc_line_harness_migrate LOGIN PASSWORD :'migrate_password'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 1;
CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public;
CREATE TABLE schema_migrations (name text PRIMARY KEY, checksum text NOT NULL);
GRANT hhc_line_harness_migrate TO CURRENT_USER;
ALTER DATABASE hhc_line_harness OWNER TO hhc_line_harness_migrate;
ALTER SCHEMA public OWNER TO hhc_line_harness_migrate;
ALTER TABLE schema_migrations OWNER TO hhc_line_harness_migrate;
REVOKE ALL ON DATABASE hhc_line_harness FROM PUBLIC;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT CONNECT ON DATABASE hhc_line_harness TO hhc_line_harness_api, hhc_line_harness_worker;
GRANT USAGE ON SCHEMA public TO hhc_line_harness_api, hhc_line_harness_worker;
ALTER DEFAULT PRIVILEGES FOR ROLE hhc_line_harness_migrate IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO hhc_line_harness_api, hhc_line_harness_worker;
ALTER DEFAULT PRIVILEGES FOR ROLE hhc_line_harness_migrate IN SCHEMA public
  GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO hhc_line_harness_api, hhc_line_harness_worker;
COMMIT;
