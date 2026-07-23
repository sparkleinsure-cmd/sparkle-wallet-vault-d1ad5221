-- Appliance insurance applications, credit facilities and claims.
CREATE TABLE IF NOT EXISTS public.insurance_applications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  selected_items text[] NOT NULL,
  bank_statement_paths text[] NOT NULL,
  payslip_path text NOT NULL,
  id_copy_path text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','declined')),
  credit_limit numeric(18,2) NOT NULL DEFAULT 0 CHECK (credit_limit >= 0),
  credit_available numeric(18,2) NOT NULL DEFAULT 0 CHECK (credit_available >= 0),
  admin_note text,
  reviewed_by uuid REFERENCES auth.users(id),
  reviewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (cardinality(selected_items) BETWEEN 1 AND 20),
  CHECK (cardinality(bank_statement_paths) BETWEEN 1 AND 3)
);

CREATE TABLE IF NOT EXISTS public.insurance_claims (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id uuid NOT NULL REFERENCES public.insurance_applications(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  item text NOT NULL,
  requested_amount numeric(18,2) NOT NULL CHECK (requested_amount > 0),
  quotation_path text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','declined')),
  approved_amount numeric(18,2),
  admin_note text,
  reviewed_by uuid REFERENCES auth.users(id),
  reviewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS insurance_applications_user_created_idx ON public.insurance_applications(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS insurance_claims_user_created_idx ON public.insurance_claims(user_id, created_at DESC);

ALTER TABLE public.insurance_applications ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.insurance_claims ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "own insurance applications read" ON public.insurance_applications;
CREATE POLICY "own insurance applications read" ON public.insurance_applications FOR SELECT TO authenticated USING (user_id=auth.uid());
DROP POLICY IF EXISTS "own insurance claims read" ON public.insurance_claims;
CREATE POLICY "own insurance claims read" ON public.insurance_claims FOR SELECT TO authenticated USING (user_id=auth.uid());
GRANT SELECT ON public.insurance_applications, public.insurance_claims TO authenticated;

INSERT INTO storage.buckets(id,name,public,file_size_limit)
VALUES ('insurance','insurance',false,10485760)
ON CONFLICT(id) DO UPDATE SET public=false,file_size_limit=10485760;
DROP POLICY IF EXISTS "insurance own upload" ON storage.objects;
CREATE POLICY "insurance own upload" ON storage.objects FOR INSERT TO authenticated
WITH CHECK (bucket_id='insurance' AND (storage.foldername(name))[1]=auth.uid()::text);
DROP POLICY IF EXISTS "insurance own read" ON storage.objects;
CREATE POLICY "insurance own read" ON storage.objects FOR SELECT TO authenticated
USING (bucket_id='insurance' AND (storage.foldername(name))[1]=auth.uid()::text);

CREATE OR REPLACE FUNCTION public.submit_insurance_application(
  p_items text[], p_bank_paths text[], p_payslip_path text, p_id_copy_path text
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_id uuid; v_path text;
BEGIN
  IF auth.uid() IS NULL OR cardinality(p_items) NOT BETWEEN 1 AND 20 OR cardinality(p_bank_paths) NOT BETWEEN 1 AND 3 THEN RAISE EXCEPTION 'Invalid insurance application'; END IF;
  IF EXISTS (SELECT 1 FROM insurance_applications WHERE user_id=auth.uid() AND status IN ('pending','approved')) THEN RAISE EXCEPTION 'You already have an active insurance application'; END IF;
  FOREACH v_path IN ARRAY p_bank_paths LOOP IF split_part(v_path,'/',1)<>auth.uid()::text THEN RAISE EXCEPTION 'Invalid document path'; END IF; END LOOP;
  IF split_part(p_payslip_path,'/',1)<>auth.uid()::text OR split_part(p_id_copy_path,'/',1)<>auth.uid()::text THEN RAISE EXCEPTION 'Invalid document path'; END IF;
  INSERT INTO insurance_applications(user_id,selected_items,bank_statement_paths,payslip_path,id_copy_path)
  VALUES(auth.uid(),p_items,p_bank_paths,p_payslip_path,p_id_copy_path) RETURNING id INTO v_id;
  RETURN v_id;
END; $$;

CREATE OR REPLACE FUNCTION public.submit_insurance_claim(p_item text,p_amount numeric,p_quotation_path text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_app insurance_applications%ROWTYPE; v_id uuid;
BEGIN
  SELECT * INTO v_app FROM insurance_applications WHERE user_id=auth.uid() AND status='approved' ORDER BY created_at DESC LIMIT 1;
  IF NOT FOUND THEN RAISE EXCEPTION 'No approved insurance facility found'; END IF;
  IF NOT (p_item=ANY(v_app.selected_items)) OR p_amount<=0 OR p_amount>v_app.credit_available THEN RAISE EXCEPTION 'Invalid claim amount or item'; END IF;
  IF split_part(p_quotation_path,'/',1)<>auth.uid()::text THEN RAISE EXCEPTION 'Invalid quotation path'; END IF;
  IF EXISTS(SELECT 1 FROM insurance_claims WHERE user_id=auth.uid() AND status='pending') THEN RAISE EXCEPTION 'Your previous claim is still being reviewed'; END IF;
  INSERT INTO insurance_claims(application_id,user_id,item,requested_amount,quotation_path)
  VALUES(v_app.id,auth.uid(),p_item,p_amount,p_quotation_path) RETURNING id INTO v_id;
  RETURN v_id;
END; $$;

CREATE OR REPLACE FUNCTION public.admin_review_insurance_application(p_application_id uuid,p_status text,p_credit numeric,p_note text DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
  IF NOT public.has_role(auth.uid(),'admin') THEN RAISE EXCEPTION 'Forbidden'; END IF;
  IF p_status NOT IN ('approved','declined') OR (p_status='approved' AND (p_credit<=0 OR p_credit>1000000)) THEN RAISE EXCEPTION 'Invalid review'; END IF;
  UPDATE insurance_applications SET status=p_status,credit_limit=CASE WHEN p_status='approved' THEN p_credit ELSE 0 END,
    credit_available=CASE WHEN p_status='approved' THEN p_credit ELSE 0 END,admin_note=NULLIF(trim(p_note),''),reviewed_by=auth.uid(),reviewed_at=now(),updated_at=now()
  WHERE id=p_application_id AND status='pending';
  IF NOT FOUND THEN RAISE EXCEPTION 'Application already processed or not found'; END IF;
END; $$;

CREATE OR REPLACE FUNCTION public.admin_review_insurance_claim(p_claim_id uuid,p_status text,p_approved_amount numeric,p_note text DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_claim insurance_claims%ROWTYPE; v_app insurance_applications%ROWTYPE;
BEGIN
  IF NOT public.has_role(auth.uid(),'admin') THEN RAISE EXCEPTION 'Forbidden'; END IF;
  IF p_status NOT IN ('approved','declined') THEN RAISE EXCEPTION 'Invalid review'; END IF;
  SELECT * INTO v_claim FROM insurance_claims WHERE id=p_claim_id AND status='pending' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Claim already processed or not found'; END IF;
  SELECT * INTO v_app FROM insurance_applications WHERE id=v_claim.application_id FOR UPDATE;
  IF p_status='approved' AND (p_approved_amount<=0 OR p_approved_amount>v_claim.requested_amount OR p_approved_amount>v_app.credit_available) THEN RAISE EXCEPTION 'Approved amount exceeds the claim or available facility'; END IF;
  UPDATE insurance_claims SET status=p_status,approved_amount=CASE WHEN p_status='approved' THEN p_approved_amount ELSE NULL END,
    admin_note=NULLIF(trim(p_note),''),reviewed_by=auth.uid(),reviewed_at=now() WHERE id=p_claim_id;
  IF p_status='approved' THEN
    UPDATE insurance_applications SET credit_available=credit_available-p_approved_amount,updated_at=now() WHERE id=v_app.id;
    UPDATE wallets SET balance=balance+p_approved_amount,updated_at=now() WHERE user_id=v_claim.user_id AND currency='ZAR';
    INSERT INTO transactions(user_id,type,currency,amount,status,description,reference)
    VALUES(v_claim.user_id,'bonus','ZAR',p_approved_amount,'completed','Insurance claim payout - '||v_claim.item,v_claim.id::text);
  END IF;
END; $$;

REVOKE ALL ON FUNCTION public.submit_insurance_application(text[],text[],text,text),public.submit_insurance_claim(text,numeric,text),public.admin_review_insurance_application(uuid,text,numeric,text),public.admin_review_insurance_claim(uuid,text,numeric,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.submit_insurance_application(text[],text[],text,text),public.submit_insurance_claim(text,numeric,text),public.admin_review_insurance_application(uuid,text,numeric,text),public.admin_review_insurance_claim(uuid,text,numeric,text) TO authenticated;
