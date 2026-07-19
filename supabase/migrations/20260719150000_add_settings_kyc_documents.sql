-- KYC is optional during onboarding. Both documents are submitted later from
-- Settings and remain pending until an administrator reviews them.
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS selfie_url text;

CREATE OR REPLACE FUNCTION public.submit_kyc_review(p_proof_path text, p_selfie_path text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF auth.uid() IS NULL
     OR length(trim(COALESCE(p_proof_path, ''))) < 3
     OR length(trim(COALESCE(p_selfie_path, ''))) < 3
     OR split_part(p_proof_path, '/', 1) <> auth.uid()::text
     OR split_part(p_selfie_path, '/', 1) <> auth.uid()::text THEN
    RAISE EXCEPTION 'Invalid verification submission';
  END IF;
  UPDATE public.profiles
  SET proof_url = p_proof_path, selfie_url = p_selfie_path, kyc_status = 'pending'
  WHERE id = auth.uid();
END;
$$;

REVOKE ALL ON FUNCTION public.submit_kyc_review(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.submit_kyc_review(text, text) TO authenticated;
