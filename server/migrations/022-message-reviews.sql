-- Add compare-and-swap state without rewriting any existing note, author,
-- source revision or timestamp. This remains the latest private note, not a
-- newly invented history of notes that the old service did not retain.
ALTER TABLE public.cb_message_reviews ADD COLUMN review_version integer NOT NULL DEFAULT 1
  CHECK (review_version > 0);

-- Receipts contain no original text or private note. The pinned source FK is
-- immutable; do not point a historical receipt at the mutable review head.
CREATE TABLE public.cb_message_review_requests (
  center_id text NOT NULL, conversation_id text NOT NULL, actor_id text NOT NULL,
  client_id text NOT NULL CHECK (client_id ~ '^[a-zA-Z0-9-]{8,100}$'),
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  message_id text NOT NULL, message_revision integer NOT NULL CHECK (message_revision > 0),
  review_version integer NOT NULL CHECK (review_version > 0),
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (center_id,actor_id,client_id),
  FOREIGN KEY (center_id,conversation_id,actor_id)
    REFERENCES public.cb_participants(center_id,conversation_id,user_id),
  FOREIGN KEY (center_id,conversation_id,message_id,message_revision)
    REFERENCES public.cb_message_text_revisions(center_id,conversation_id,message_id,revision)
);

CREATE FUNCTION public.cb_message_review_guard() RETURNS trigger LANGUAGE plpgsql
  SET search_path = pg_catalog,pg_temp AS $$
BEGIN
  IF TG_TABLE_NAME = 'cb_message_review_requests' THEN
    IF TG_OP <> 'INSERT' OR NOT EXISTS (SELECT 1 FROM public.cb_message_reviews r WHERE
        (r.center_id,r.conversation_id,r.message_id,r.message_revision,r.review_version,r.reviewer_id) =
        (NEW.center_id,NEW.conversation_id,NEW.message_id,NEW.message_revision,NEW.review_version,NEW.actor_id)) THEN
      RAISE EXCEPTION 'review receipt has no matching result' USING ERRCODE = '23514';
    END IF;
    NEW.occurred_at := clock_timestamp();
    RETURN NEW;
  END IF;
  IF TG_TABLE_NAME <> 'cb_message_reviews' OR TG_OP NOT IN ('INSERT','UPDATE') THEN
    RAISE EXCEPTION 'review identity is retained' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.review_version <> 1 THEN
      RAISE EXCEPTION 'invalid initial review version' USING ERRCODE = '23514';
    END IF;
  ELSE
    IF (NEW.center_id,NEW.conversation_id,NEW.message_id) IS DISTINCT FROM
        (OLD.center_id,OLD.conversation_id,OLD.message_id) OR
        NEW.review_version::bigint <> OLD.review_version::bigint + 1 THEN
      RAISE EXCEPTION 'invalid review advance' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.cb_message_text_heads h
      JOIN public.cb_message_text_revisions v ON
        (v.center_id,v.conversation_id,v.message_id,v.revision) =
        (h.center_id,h.conversation_id,h.message_id,h.current_revision)
      WHERE (h.center_id,h.conversation_id,h.message_id,h.current_revision) =
        (NEW.center_id,NEW.conversation_id,NEW.message_id,NEW.message_revision) AND v.operation <> 'all') THEN
    RAISE EXCEPTION 'review source is unavailable' USING ERRCODE = '23514';
  END IF;
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END; $$;
REVOKE ALL ON FUNCTION public.cb_message_review_guard() FROM PUBLIC;
CREATE TRIGGER cb_message_review_guard BEFORE INSERT OR UPDATE OR DELETE ON public.cb_message_reviews
  FOR EACH ROW EXECUTE FUNCTION public.cb_message_review_guard();
CREATE TRIGGER cb_message_review_request_guard BEFORE INSERT ON public.cb_message_review_requests
  FOR EACH ROW EXECUTE FUNCTION public.cb_message_review_guard();
CREATE TRIGGER cb_message_review_request_immutable BEFORE UPDATE OR DELETE ON public.cb_message_review_requests
  FOR EACH ROW EXECUTE FUNCTION public.cb_immutable_record_data();

CREATE TRIGGER cb_000_recovery_guard BEFORE INSERT OR UPDATE OR DELETE ON public.cb_message_reviews
  FOR EACH ROW EXECUTE FUNCTION public.cb_recovery_write_guard();
CREATE TRIGGER cb_recovery_truncate_guard BEFORE TRUNCATE ON public.cb_message_reviews
  FOR EACH STATEMENT EXECUTE FUNCTION public.cb_recovery_write_guard();
CREATE TRIGGER cb_000_recovery_guard BEFORE INSERT OR UPDATE OR DELETE ON public.cb_message_review_requests
  FOR EACH ROW EXECUTE FUNCTION public.cb_recovery_write_guard();
CREATE TRIGGER cb_recovery_truncate_guard BEFORE TRUNCATE ON public.cb_message_review_requests
  FOR EACH STATEMENT EXECUTE FUNCTION public.cb_recovery_write_guard();
