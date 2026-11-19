-- Public prototype attachments have structural validation, not local-worker
-- malware/decode approval. Keep their bytes and evidence out of public media.
CREATE SCHEMA carebridge_web;
CREATE TABLE carebridge_web.schema_version (
  version integer PRIMARY KEY CHECK (version = 1),
  checksum text NOT NULL CHECK (checksum ~ '^[a-f0-9]{64}$')
);
CREATE TABLE carebridge_web.center_limits (
  center_id text PRIMARY KEY REFERENCES public.cb_centers(id),
  limit_bytes integer NOT NULL CHECK (limit_bytes BETWEEN 1 AND 104857600)
);
CREATE TABLE carebridge_web.attachments (
  center_id text NOT NULL REFERENCES carebridge_web.center_limits(center_id),
  conversation_id text NOT NULL,
  id text NOT NULL CHECK (id ~ '^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'),
  owner_id text NOT NULL,
  client_id text NOT NULL CHECK (client_id ~ '^[A-Za-z0-9-]{8,100}$'),
  type text NOT NULL CHECK (type IN ('image/png','image/jpeg','image/webp','video/mp4')),
  size integer NOT NULL CHECK (size BETWEEN 1 AND 3145728),
  sha256 text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  created_sequence bigint NOT NULL CHECK (created_sequence BETWEEN 1 AND 9007199254740991),
  width integer NOT NULL CHECK (width BETWEEN 1 AND 8192),
  height integer NOT NULL CHECK (height BETWEEN 1 AND 8192),
  duration double precision,
  content bytea,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL DEFAULT clock_timestamp() + interval '1 hour',
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','bound','expired','discarded')),
  bound_message_id text,
  ordinal integer CHECK (ordinal BETWEEN 0 AND 3),
  PRIMARY KEY (center_id,conversation_id,id),
  UNIQUE (center_id,owner_id,client_id),
  UNIQUE (center_id,conversation_id,bound_message_id,ordinal),
  CHECK (width::bigint * height <= 40000000),
  CHECK ((type='video/mp4' AND duration IS NOT NULL AND duration > 0 AND duration <= 600) OR (type<>'video/mp4' AND duration IS NULL)),
  CHECK (expires_at > created_at AND expires_at <= created_at + interval '1 hour 1 second'),
  CHECK ((state='bound') = (bound_message_id IS NOT NULL AND ordinal IS NOT NULL)),
  CHECK (state='bound' OR (bound_message_id IS NULL AND ordinal IS NULL)),
  CHECK ((state IN ('pending','bound') AND content IS NOT NULL AND octet_length(content)=size
    AND encode(sha256(content),'hex')=sha256) OR (state IN ('expired','discarded') AND content IS NULL)),
  FOREIGN KEY (center_id,conversation_id,owner_id) REFERENCES public.cb_participants(center_id,conversation_id,user_id),
  FOREIGN KEY (center_id,conversation_id,bound_message_id) REFERENCES public.cb_messages(center_id,conversation_id,id)
);
CREATE INDEX web_media_bound ON carebridge_web.attachments(center_id,conversation_id,bound_message_id);
CREATE INDEX web_media_pending ON carebridge_web.attachments(center_id,expires_at) WHERE state='pending';
CREATE TABLE carebridge_web.message_requests (
  center_id text NOT NULL,
  conversation_id text NOT NULL,
  owner_id text NOT NULL,
  client_id text NOT NULL CHECK (client_id ~ '^[A-Za-z0-9-]{8,100}$'),
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  message_id text NOT NULL,
  PRIMARY KEY (center_id,owner_id,client_id),
  UNIQUE (center_id,conversation_id,message_id),
  FOREIGN KEY (center_id,conversation_id,owner_id) REFERENCES public.cb_participants(center_id,conversation_id,user_id),
  FOREIGN KEY (center_id,conversation_id,message_id) REFERENCES public.cb_messages(center_id,conversation_id,id)
);
CREATE FUNCTION carebridge_web.guard_attachment() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'attachment receipt is retained' USING ERRCODE='23514'; END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.state<>'pending' OR NEW.bound_message_id IS NOT NULL OR NEW.ordinal IS NOT NULL THEN
      RAISE EXCEPTION 'attachment starts pending' USING ERRCODE='23514'; END IF;
  ELSE
    IF (to_jsonb(NEW)-ARRAY['state','content','bound_message_id','ordinal']) IS DISTINCT FROM
       (to_jsonb(OLD)-ARRAY['state','content','bound_message_id','ordinal']) OR OLD.state<>'pending' THEN
      RAISE EXCEPTION 'attachment is immutable' USING ERRCODE='23514'; END IF;
    IF NEW.state='bound' THEN
      IF OLD.expires_at<=clock_timestamp() OR NEW.content IS DISTINCT FROM OLD.content THEN
        RAISE EXCEPTION 'attachment binding is unavailable' USING ERRCODE='23514'; END IF;
    ELSIF NEW.state IN ('expired','discarded') THEN
      IF NEW.content IS NOT NULL OR NEW.bound_message_id IS NOT NULL OR NEW.ordinal IS NOT NULL OR
         (NEW.state='expired' AND OLD.expires_at>clock_timestamp()) THEN
        RAISE EXCEPTION 'invalid attachment release' USING ERRCODE='23514'; END IF;
    ELSE RAISE EXCEPTION 'invalid attachment transition' USING ERRCODE='23514'; END IF;
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER web_attachment_guard BEFORE INSERT OR UPDATE OR DELETE ON carebridge_web.attachments
  FOR EACH ROW EXECUTE FUNCTION carebridge_web.guard_attachment();
CREATE FUNCTION carebridge_web.retain_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'request receipt is immutable' USING ERRCODE='23514'; END; $$;
CREATE TRIGGER web_message_request_guard BEFORE UPDATE OR DELETE ON carebridge_web.message_requests
  FOR EACH ROW EXECUTE FUNCTION carebridge_web.retain_receipt();
