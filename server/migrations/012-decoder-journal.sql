-- Trusted worker-service ledger only. No user/child/upload IDs, payload,
-- filenames, MIME, hashes of health data, paths, diagnostic text or verdicts.
-- The web/application runtime role must receive NO privileges here.
CREATE TABLE cb_decoder_engines (
  id text PRIMARY KEY CHECK (id ~ '^[a-zA-Z0-9:_-]{12,80}$'),
  image_id text NOT NULL CHECK (image_id ~ '^sha256:[a-f0-9]{64}$'),
  capacity smallint NOT NULL CHECK (capacity BETWEEN 1 AND 2),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (id,image_id)
);
CREATE TABLE cb_decoder_jobs (
  run uuid PRIMARY KEY CHECK (run::text ~ '^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'),
  engine_id text NOT NULL,
  image_id text NOT NULL,
  owner_id uuid NOT NULL CHECK (owner_id::text ~ '^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'),
  generation integer NOT NULL DEFAULT 1 CHECK (generation BETWEEN 1 AND 2147483647),
  phase text NOT NULL CHECK (phase IN ('reserved','creating','attached','closed')),
  container_id text CHECK (container_id ~ '^[a-f0-9]{64}$'),
  requires_recovery boolean NOT NULL DEFAULT false,
  lease_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  closed_at timestamptz,
  FOREIGN KEY (engine_id,image_id) REFERENCES cb_decoder_engines(id,image_id),
  UNIQUE (engine_id,container_id),
  CHECK (phase <> 'attached' OR container_id IS NOT NULL),
  CHECK (phase NOT IN ('reserved','creating') OR container_id IS NULL),
  CHECK ((phase = 'closed' AND closed_at IS NOT NULL AND lease_until IS NULL AND NOT requires_recovery)
    OR (phase <> 'closed' AND closed_at IS NULL AND lease_until IS NOT NULL))
);
CREATE INDEX cb_decoder_unclosed ON cb_decoder_jobs(engine_id,created_at,run) WHERE phase <> 'closed';
REVOKE ALL ON cb_decoder_engines,cb_decoder_jobs FROM PUBLIC;

CREATE FUNCTION cb_decoder_engine_guard() RETURNS trigger LANGUAGE plpgsql
  SET search_path = pg_catalog,public,pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'decoder engine configuration is immutable' USING ERRCODE = '23514';
END;
$$;
CREATE TRIGGER cb_decoder_engine_guard BEFORE UPDATE OR DELETE ON cb_decoder_engines
  FOR EACH ROW EXECUTE FUNCTION cb_decoder_engine_guard();

CREATE FUNCTION cb_decoder_job_guard() RETURNS trigger LANGUAGE plpgsql
  SET search_path = pg_catalog,public,pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'decoder job receipts are retained' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'INSERT' THEN
    PERFORM 1 FROM cb_decoder_engines WHERE id = NEW.engine_id AND image_id = NEW.image_id FOR UPDATE;
    IF EXISTS (SELECT 1 FROM cb_decoder_jobs WHERE engine_id = NEW.engine_id AND phase <> 'closed'
        AND (requires_recovery OR lease_until <= clock_timestamp()))
      OR (SELECT count(*) FROM cb_decoder_jobs WHERE engine_id = NEW.engine_id AND phase <> 'closed') >=
        (SELECT capacity FROM cb_decoder_engines WHERE id = NEW.engine_id) THEN
      RAISE EXCEPTION 'decoder capacity is unavailable' USING ERRCODE = '23514';
    END IF;
    IF NEW.phase <> 'reserved' OR NEW.generation <> 1 OR NEW.requires_recovery THEN
      RAISE EXCEPTION 'decoder job must begin reserved' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.phase = 'closed' OR (NEW.run,NEW.engine_id,NEW.image_id,NEW.created_at) IS DISTINCT FROM
      (OLD.run,OLD.engine_id,OLD.image_id,OLD.created_at)
    OR (OLD.container_id IS NOT NULL AND NEW.container_id IS DISTINCT FROM OLD.container_id)
    OR (NEW.owner_id IS DISTINCT FROM OLD.owner_id AND (NEW.generation <> OLD.generation+1 OR NOT NEW.requires_recovery))
    OR (NEW.owner_id IS DISTINCT FROM OLD.owner_id AND OLD.lease_until > clock_timestamp())
    OR (NEW.generation <> OLD.generation AND (NEW.generation <> OLD.generation+1 OR NOT NEW.requires_recovery))
    OR (OLD.phase = 'reserved' AND NEW.phase NOT IN ('reserved','creating','closed'))
    OR (OLD.phase = 'creating' AND NEW.phase NOT IN ('creating','attached'))
    OR (OLD.phase = 'attached' AND NEW.phase NOT IN ('attached','closed')) THEN
    RAISE EXCEPTION 'decoder receipt transition is invalid' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER cb_decoder_job_guard BEFORE INSERT OR UPDATE OR DELETE ON cb_decoder_jobs
  FOR EACH ROW EXECUTE FUNCTION cb_decoder_job_guard();
