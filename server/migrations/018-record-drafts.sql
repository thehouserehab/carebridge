-- Keep partly written rows out of the existing, strictly numeric assessment
-- table. No historical revision or migration checksum is rewritten.
CREATE FUNCTION cb_valid_draft_assessments(rows jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE row jsonb; key text; numeric_value double precision;
BEGIN
  IF jsonb_typeof(rows) IS DISTINCT FROM 'array' THEN RETURN false; END IF;
  IF jsonb_array_length(rows) NOT BETWEEN 1 AND 20 THEN RETURN false; END IF;
  FOR row IN SELECT value FROM jsonb_array_elements(rows) LOOP
    IF jsonb_typeof(row) IS DISTINCT FROM 'object' THEN RETURN false; END IF;
    IF NOT (row ?& ARRAY['tool','item','value','unit','context']) OR
        (SELECT count(*) FROM jsonb_object_keys(row)) <> 5 THEN RETURN false; END IF;
    FOREACH key IN ARRAY ARRAY['tool','item','unit','context'] LOOP
      IF jsonb_typeof(row -> key) IS DISTINCT FROM 'string' OR
          length(row ->> key) > (CASE WHEN key = 'context' THEN 300 ELSE 100 END) THEN RETURN false; END IF;
    END LOOP;
    IF jsonb_typeof(row -> 'value') = 'number' THEN
      numeric_value := (row ->> 'value')::double precision;
      IF NOT (numeric_value > '-Infinity'::double precision AND numeric_value < 'Infinity'::double precision) THEN RETURN false; END IF;
    ELSIF jsonb_typeof(row -> 'value') IS DISTINCT FROM 'null' THEN RETURN false;
    END IF;
  END LOOP;
  RETURN true;
EXCEPTION WHEN numeric_value_out_of_range OR invalid_text_representation THEN RETURN false;
END;
$$;

ALTER TABLE cb_record_revisions ADD COLUMN draft_assessments jsonb;
ALTER TABLE cb_record_revisions ADD CONSTRAINT cb_record_draft_assessments
  CHECK (draft_assessments IS NULL OR (status = 'draft' AND cb_valid_draft_assessments(draft_assessments)));

-- Existing seal and deferred-commit guards cover the new column as well.
-- A draft row list and clinical assessment rows cannot coexist in one revision.
CREATE OR REPLACE FUNCTION cb_check_record_detail_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE is_sealed boolean; draft_rows jsonb;
BEGIN
  SELECT sealed, draft_assessments INTO is_sealed, draft_rows FROM cb_record_revisions WHERE center_id = NEW.center_id
    AND conversation_id = NEW.conversation_id AND record_id = NEW.record_id AND revision = NEW.revision FOR UPDATE;
  IF is_sealed THEN
    RAISE EXCEPTION 'sealed record details are immutable' USING ERRCODE = '23514';
  END IF;
  IF TG_TABLE_NAME = 'cb_record_assessments' AND draft_rows IS NOT NULL THEN
    RAISE EXCEPTION 'draft rows are not clinical measurements' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
