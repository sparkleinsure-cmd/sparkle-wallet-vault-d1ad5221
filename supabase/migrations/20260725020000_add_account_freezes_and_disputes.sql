-- Administrators can freeze an account during an AML/compliance review.
-- The account holder can respond with a private PDF and the full decision
-- history remains available for audit purposes.
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS account_frozen boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS frozen_at timestamptz,
  ADD COLUMN IF NOT EXISTS frozen_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS freeze_reason text;

CREATE TABLE IF NOT EXISTS public.account_freeze_disputes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  document_path text NOT NULL,
  statement text NOT NULL CHECK (length(statement) BETWEEN 10 AND 2000),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  admin_note text,
  reviewed_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  reviewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS account_freeze_disputes_user_created_idx
  ON public.account_freeze_disputes(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS account_freeze_disputes_pending_idx
  ON public.account_freeze_disputes(created_at DESC) WHERE status = 'pending';

ALTER TABLE public.account_freeze_disputes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "users read own freeze disputes" ON public.account_freeze_disputes;
CREATE POLICY "users read own freeze disputes" ON public.account_freeze_disputes
  FOR SELECT TO authenticated USING (user_id = auth.uid());

DROP POLICY IF EXISTS "admins manage freeze disputes" ON public.account_freeze_disputes;
CREATE POLICY "admins manage freeze disputes" ON public.account_freeze_disputes
  FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin'::public.app_role))
  WITH CHECK (public.has_role(auth.uid(), 'admin'::public.app_role));

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('account-disputes', 'account-disputes', false, 10485760, ARRAY['application/pdf'])
ON CONFLICT (id) DO UPDATE SET
  public = EXCLUDED.public,
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

DROP POLICY IF EXISTS "users upload own account disputes" ON storage.objects;
CREATE POLICY "users upload own account disputes" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'account-disputes'
    AND (storage.foldername(name))[1] = auth.uid()::text
    AND lower(storage.extension(name)) = 'pdf'
  );

DROP POLICY IF EXISTS "users read own account disputes" ON storage.objects;
CREATE POLICY "users read own account disputes" ON storage.objects
  FOR SELECT TO authenticated
  USING (
    bucket_id = 'account-disputes'
    AND (
      (storage.foldername(name))[1] = auth.uid()::text
      OR public.has_role(auth.uid(), 'admin'::public.app_role)
    )
  );

CREATE OR REPLACE FUNCTION public.submit_account_freeze_dispute(
  p_document_path text,
  p_statement text
)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_id uuid;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Unauthorized'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.profiles WHERE id = auth.uid() AND account_frozen
  ) THEN
    RAISE EXCEPTION 'This account is not frozen';
  END IF;
  IF split_part(p_document_path, '/', 1) <> auth.uid()::text
     OR lower(right(trim(p_document_path), 4)) <> '.pdf' THEN
    RAISE EXCEPTION 'Invalid dispute document';
  END IF;
  IF length(trim(COALESCE(p_statement, ''))) NOT BETWEEN 10 AND 2000 THEN
    RAISE EXCEPTION 'Your written statement must be between 10 and 2000 characters';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.account_freeze_disputes
    WHERE user_id = auth.uid() AND status = 'pending'
  ) THEN
    RAISE EXCEPTION 'A dispute is already awaiting review';
  END IF;

  INSERT INTO public.account_freeze_disputes(user_id, document_path, statement)
  VALUES (auth.uid(), p_document_path, trim(p_statement))
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_set_account_frozen(
  p_user_id uuid,
  p_frozen boolean,
  p_reason text DEFAULT NULL,
  p_admin_note text DEFAULT NULL
)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.has_role(auth.uid(), 'admin'::public.app_role) THEN
    RAISE EXCEPTION 'Forbidden';
  END IF;
  IF p_user_id = auth.uid() THEN RAISE EXCEPTION 'You cannot freeze your own admin account'; END IF;
  IF p_frozen AND length(trim(COALESCE(p_reason, ''))) < 5 THEN
    RAISE EXCEPTION 'Provide a reason for freezing the account';
  END IF;

  UPDATE public.profiles
  SET account_frozen = p_frozen,
      frozen_at = CASE WHEN p_frozen THEN now() ELSE NULL END,
      frozen_by = CASE WHEN p_frozen THEN auth.uid() ELSE NULL END,
      freeze_reason = CASE WHEN p_frozen THEN trim(p_reason) ELSE NULL END
  WHERE id = p_user_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'User not found'; END IF;

  IF NOT p_frozen THEN
    UPDATE public.account_freeze_disputes
    SET status = 'approved',
        admin_note = NULLIF(trim(COALESCE(p_admin_note, '')), ''),
        reviewed_by = auth.uid(),
        reviewed_at = now()
    WHERE id = (
      SELECT id FROM public.account_freeze_disputes
      WHERE user_id = p_user_id AND status = 'pending'
      ORDER BY created_at DESC LIMIT 1
    );
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_reject_account_freeze_dispute(
  p_dispute_id uuid,
  p_admin_note text
)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.has_role(auth.uid(), 'admin'::public.app_role) THEN
    RAISE EXCEPTION 'Forbidden';
  END IF;
  IF length(trim(COALESCE(p_admin_note, ''))) < 5 THEN
    RAISE EXCEPTION 'Provide a review note';
  END IF;
  UPDATE public.account_freeze_disputes
  SET status = 'rejected', admin_note = trim(p_admin_note),
      reviewed_by = auth.uid(), reviewed_at = now()
  WHERE id = p_dispute_id AND status = 'pending';
  IF NOT FOUND THEN RAISE EXCEPTION 'Pending dispute not found'; END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.submit_account_freeze_dispute(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_set_account_frozen(uuid, boolean, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_reject_account_freeze_dispute(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.submit_account_freeze_dispute(text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_set_account_frozen(uuid, boolean, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_reject_account_freeze_dispute(uuid, text) TO authenticated;
