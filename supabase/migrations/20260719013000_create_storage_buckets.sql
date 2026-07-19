-- These buckets were created manually in Lovable Cloud. Create them in every
-- standalone Supabase project so the browser uploads used by the app work.
INSERT INTO storage.buckets (id, name, public, file_size_limit)
VALUES
  ('kyc', 'kyc', false, 8388608),
  ('deposits', 'deposits', false, 10485760)
ON CONFLICT (id) DO UPDATE
SET
  name = EXCLUDED.name,
  public = EXCLUDED.public,
  file_size_limit = EXCLUDED.file_size_limit;

-- A user may only access files inside the folder named after their auth UID.
-- Admin/server access is handled with the service-role client.
DROP POLICY IF EXISTS "kyc own upload" ON storage.objects;
CREATE POLICY "kyc own upload" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'kyc'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

DROP POLICY IF EXISTS "kyc own update" ON storage.objects;
CREATE POLICY "kyc own update" ON storage.objects
  FOR UPDATE TO authenticated
  USING (
    bucket_id = 'kyc'
    AND (storage.foldername(name))[1] = auth.uid()::text
  )
  WITH CHECK (
    bucket_id = 'kyc'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

DROP POLICY IF EXISTS "kyc own read" ON storage.objects;
CREATE POLICY "kyc own read" ON storage.objects
  FOR SELECT TO authenticated
  USING (
    bucket_id = 'kyc'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

DROP POLICY IF EXISTS "users upload own deposit proofs" ON storage.objects;
CREATE POLICY "users upload own deposit proofs" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'deposits'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

DROP POLICY IF EXISTS "users read own deposit proofs" ON storage.objects;
CREATE POLICY "users read own deposit proofs" ON storage.objects
  FOR SELECT TO authenticated
  USING (
    bucket_id = 'deposits'
    AND (
      (storage.foldername(name))[1] = auth.uid()::text
      OR public.has_role(auth.uid(), 'admin')
    )
  );
