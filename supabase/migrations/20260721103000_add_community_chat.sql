-- Community chat with moderation guardrails for app-store UGC review:
-- content filtering, user/content reports, user blocks, and authenticated
-- image storage.

CREATE TABLE IF NOT EXISTS public.community_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  account_id text NOT NULL DEFAULT '',
  author_name text NOT NULL DEFAULT 'Sparkle member',
  body text NOT NULL DEFAULT '',
  image_path text,
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT community_message_has_content CHECK (
    length(trim(body)) > 0 OR image_path IS NOT NULL
  ),
  CONSTRAINT community_message_body_length CHECK (char_length(body) <= 1000),
  CONSTRAINT community_message_image_path CHECK (
    image_path IS NULL OR split_part(image_path, '/', 1) = user_id::text
  )
);

CREATE INDEX IF NOT EXISTS community_messages_created_idx
  ON public.community_messages (created_at DESC);
CREATE INDEX IF NOT EXISTS community_messages_user_idx
  ON public.community_messages (user_id);

CREATE TABLE IF NOT EXISTS public.community_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id uuid NOT NULL REFERENCES public.community_messages(id) ON DELETE CASCADE,
  reporter_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  reported_user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  reason text NOT NULL DEFAULT 'Reported from app',
  status text NOT NULL DEFAULT 'open',
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  resolved_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  CONSTRAINT community_report_reason_length CHECK (char_length(reason) BETWEEN 3 AND 500),
  CONSTRAINT community_report_status CHECK (status IN ('open', 'reviewing', 'resolved', 'dismissed')),
  UNIQUE (message_id, reporter_id)
);

CREATE INDEX IF NOT EXISTS community_reports_status_created_idx
  ON public.community_reports (status, created_at DESC);

CREATE TABLE IF NOT EXISTS public.community_blocks (
  blocker_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  blocked_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (blocker_id, blocked_id),
  CONSTRAINT community_blocks_not_self CHECK (blocker_id <> blocked_id)
);

CREATE OR REPLACE FUNCTION public.prepare_community_message()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_profile public.profiles%ROWTYPE;
  v_body text := trim(COALESCE(NEW.body, ''));
BEGIN
  IF auth.uid() IS NULL OR NEW.user_id <> auth.uid() THEN
    RAISE EXCEPTION 'Forbidden';
  END IF;

  IF NEW.image_path IS NOT NULL AND split_part(NEW.image_path, '/', 1) <> auth.uid()::text THEN
    RAISE EXCEPTION 'Invalid community image';
  END IF;

  -- Lightweight server-side filter. This is intentionally conservative and
  -- pairs with reporting/blocking tools for human moderation.
  IF v_body ~* '(porn|nude|sex|kill yourself|terror|bomb|scam)' THEN
    RAISE EXCEPTION 'This message cannot be posted. Please keep the community safe and respectful.';
  END IF;

  SELECT * INTO v_profile FROM public.profiles WHERE id = auth.uid();
  NEW.body := left(v_body, 1000);
  NEW.account_id := COALESCE(v_profile.account_id, '');
  NEW.author_name := trim(
    COALESCE(NULLIF(v_profile.first_name, ''), 'Sparkle') || ' ' ||
    COALESCE(NULLIF(v_profile.surname, ''), 'member')
  );
  NEW.deleted_at := NULL;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS prepare_community_message_trigger ON public.community_messages;
CREATE TRIGGER prepare_community_message_trigger
BEFORE INSERT OR UPDATE OF body, image_path ON public.community_messages
FOR EACH ROW EXECUTE FUNCTION public.prepare_community_message();

ALTER TABLE public.community_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.community_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.community_blocks ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "community messages read" ON public.community_messages;
CREATE POLICY "community messages read" ON public.community_messages
  FOR SELECT TO authenticated
  USING (
    deleted_at IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM public.community_blocks b
      WHERE b.blocker_id = auth.uid() AND b.blocked_id = community_messages.user_id
    )
    AND NOT EXISTS (
      SELECT 1 FROM public.community_blocks b
      WHERE b.blocker_id = community_messages.user_id AND b.blocked_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "community messages create" ON public.community_messages;
CREATE POLICY "community messages create" ON public.community_messages
  FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS "own community message delete" ON public.community_messages;
CREATE POLICY "own community message delete" ON public.community_messages
  FOR UPDATE TO authenticated
  USING (user_id = auth.uid() OR public.has_role(auth.uid(), 'admin'::public.app_role))
  WITH CHECK (user_id = auth.uid() OR public.has_role(auth.uid(), 'admin'::public.app_role));

DROP POLICY IF EXISTS "own community reports create" ON public.community_reports;
CREATE POLICY "own community reports create" ON public.community_reports
  FOR INSERT TO authenticated
  WITH CHECK (reporter_id = auth.uid() AND reporter_id <> reported_user_id);

DROP POLICY IF EXISTS "own community reports read" ON public.community_reports;
CREATE POLICY "own community reports read" ON public.community_reports
  FOR SELECT TO authenticated
  USING (reporter_id = auth.uid() OR public.has_role(auth.uid(), 'admin'::public.app_role));

DROP POLICY IF EXISTS "admin community reports update" ON public.community_reports;
CREATE POLICY "admin community reports update" ON public.community_reports
  FOR UPDATE TO authenticated
  USING (public.has_role(auth.uid(), 'admin'::public.app_role))
  WITH CHECK (public.has_role(auth.uid(), 'admin'::public.app_role));

DROP POLICY IF EXISTS "own community blocks manage" ON public.community_blocks;
CREATE POLICY "own community blocks manage" ON public.community_blocks
  FOR ALL TO authenticated
  USING (blocker_id = auth.uid())
  WITH CHECK (blocker_id = auth.uid());

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('community', 'community', false, 1048576, ARRAY['image/jpeg', 'image/png', 'image/webp', 'image/gif'])
ON CONFLICT (id) DO UPDATE SET
  public = EXCLUDED.public,
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

DROP POLICY IF EXISTS "community images authenticated read" ON storage.objects;
CREATE POLICY "community images authenticated read" ON storage.objects
  FOR SELECT TO authenticated
  USING (bucket_id = 'community');

DROP POLICY IF EXISTS "community images own upload" ON storage.objects;
CREATE POLICY "community images own upload" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'community'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

DROP POLICY IF EXISTS "community images own delete" ON storage.objects;
CREATE POLICY "community images own delete" ON storage.objects
  FOR DELETE TO authenticated
  USING (
    bucket_id = 'community'
    AND ((storage.foldername(name))[1] = auth.uid()::text OR public.has_role(auth.uid(), 'admin'::public.app_role))
  );

GRANT SELECT, INSERT, UPDATE ON public.community_messages TO authenticated;
GRANT SELECT, INSERT ON public.community_reports TO authenticated;
GRANT UPDATE ON public.community_reports TO authenticated;
GRANT SELECT, INSERT, DELETE ON public.community_blocks TO authenticated;
GRANT ALL ON public.community_messages, public.community_reports, public.community_blocks TO service_role;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.community_messages;
  END IF;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
