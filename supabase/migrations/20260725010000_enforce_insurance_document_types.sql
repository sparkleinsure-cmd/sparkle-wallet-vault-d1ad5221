-- Restrict insurance uploads at the bucket and application-submission layers.
UPDATE storage.buckets
SET allowed_mime_types=ARRAY['application/pdf','image/*']
WHERE id='insurance';

CREATE OR REPLACE FUNCTION public.submit_insurance_application(
  p_items text[],p_bank_paths text[],p_payslip_path text,p_id_copy_path text
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=public
AS $$
DECLARE
  v_id uuid;
  v_path text;
  v_mime text;
  v_eligibility jsonb;
BEGIN
  IF auth.uid() IS NULL OR cardinality(p_items) NOT BETWEEN 1 AND 20
     OR cardinality(p_bank_paths) NOT BETWEEN 1 AND 3 THEN
    RAISE EXCEPTION 'Invalid insurance application';
  END IF;
  v_eligibility:=public.insurance_eligibility(auth.uid());
  IF NOT (v_eligibility->>'eligible')::boolean THEN
    RAISE EXCEPTION 'Insurance requires an account older than 30 days and at least R1,000 in completed deposits during the last 30 days';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.insurance_applications
    WHERE user_id=auth.uid() AND status IN ('pending','approved')
  ) THEN
    RAISE EXCEPTION 'You already have an active insurance application';
  END IF;

  FOREACH v_path IN ARRAY p_bank_paths LOOP
    IF split_part(v_path,'/',1)<>auth.uid()::text OR lower(v_path)!~ '\.pdf$' THEN
      RAISE EXCEPTION 'Bank statements must be PDF documents';
    END IF;
    SELECT lower(COALESCE(metadata->>'mimetype','')) INTO v_mime
    FROM storage.objects WHERE bucket_id='insurance' AND name=v_path;
    IF v_mime IS DISTINCT FROM 'application/pdf' THEN
      RAISE EXCEPTION 'Bank statements must be PDF documents';
    END IF;
  END LOOP;

  IF split_part(p_payslip_path,'/',1)<>auth.uid()::text OR lower(p_payslip_path)!~ '\.pdf$' THEN
    RAISE EXCEPTION 'Latest payslip must be a PDF document';
  END IF;
  SELECT lower(COALESCE(metadata->>'mimetype','')) INTO v_mime
  FROM storage.objects WHERE bucket_id='insurance' AND name=p_payslip_path;
  IF v_mime IS DISTINCT FROM 'application/pdf' THEN
    RAISE EXCEPTION 'Latest payslip must be a PDF document';
  END IF;

  IF split_part(p_id_copy_path,'/',1)<>auth.uid()::text THEN
    RAISE EXCEPTION 'Invalid ID copy path';
  END IF;
  SELECT lower(COALESCE(metadata->>'mimetype','')) INTO v_mime
  FROM storage.objects WHERE bucket_id='insurance' AND name=p_id_copy_path;
  IF v_mime IS NULL OR (v_mime<>'application/pdf' AND v_mime NOT LIKE 'image/%') THEN
    RAISE EXCEPTION 'ID copy must be an image or PDF document';
  END IF;

  INSERT INTO public.insurance_applications(
    user_id,selected_items,bank_statement_paths,payslip_path,id_copy_path
  ) VALUES(
    auth.uid(),p_items,p_bank_paths,p_payslip_path,p_id_copy_path
  ) RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

