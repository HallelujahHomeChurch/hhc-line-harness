ALTER TABLE legacy_handoffs ADD COLUMN revision bigint NOT NULL DEFAULT 1 CHECK(revision>0);
CREATE FUNCTION advance_legacy_handoff() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 NEW.revision := OLD.revision + 1;
 RETURN NEW;
END $$;
CREATE TRIGGER advance_legacy_handoff BEFORE UPDATE ON legacy_handoffs
FOR EACH ROW EXECUTE FUNCTION advance_legacy_handoff();
CREATE FUNCTION advance_legacy_source_handoff() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 UPDATE legacy_handoffs SET revision=revision+1 WHERE channel_id=COALESCE(NEW.channel_id,OLD.channel_id);
 RETURN NULL;
END $$;
CREATE TRIGGER advance_legacy_source_handoff AFTER INSERT OR UPDATE OR DELETE ON legacy_sources
FOR EACH ROW EXECUTE FUNCTION advance_legacy_source_handoff();
