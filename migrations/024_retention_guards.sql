ALTER TABLE runtime_state ADD COLUMN floor_enforced boolean NOT NULL DEFAULT false;
CREATE FUNCTION monotonic_runtime() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.generation<OLD.generation OR (OLD.floor_enforced AND (NEW.ingest_floor<OLD.ingest_floor OR NOT NEW.floor_enforced)) THEN
  RAISE EXCEPTION 'runtime_regression';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER monotonic_runtime BEFORE UPDATE ON runtime_state FOR EACH ROW EXECUTE FUNCTION monotonic_runtime();
CREATE FUNCTION monotonic_source_denial() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.state IN ('revoked','expired') AND NEW.state NOT IN ('revoked','expired') THEN
  RAISE EXCEPTION 'source_resurrection';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER monotonic_source_denial BEFORE UPDATE ON sources FOR EACH ROW EXECUTE FUNCTION monotonic_source_denial();
