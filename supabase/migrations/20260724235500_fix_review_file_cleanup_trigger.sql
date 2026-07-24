-- A trigger record only exposes columns from its own table. Branch on the
-- table first so profile/KYC updates never attempt to read transaction fields.
CREATE OR REPLACE FUNCTION public.schedule_review_file_cleanup()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=public
AS $$
DECLARE v_decision_at timestamptz := now();
BEGIN
  IF TG_TABLE_NAME='transactions' THEN
    IF NEW.type='deposit'
       AND OLD.status='pending' AND NEW.status IN ('completed','declined') THEN
      UPDATE public.review_file_cleanup_queue
        SET decision_at=v_decision_at,delete_after=v_decision_at+interval '5 minutes',last_error=NULL
        WHERE bucket_id='deposits' AND object_path=NEW.proof_url
          AND deleted_at IS NULL;
    END IF;
  ELSIF TG_TABLE_NAME='profiles' THEN
    IF OLD.kyc_status='pending' AND NEW.kyc_status IN ('verified','rejected') THEN
      UPDATE public.review_file_cleanup_queue
        SET decision_at=v_decision_at,delete_after=v_decision_at+interval '5 minutes',last_error=NULL
        WHERE bucket_id='kyc' AND object_path IN (NEW.proof_url,NEW.selfie_url)
          AND deleted_at IS NULL;
    END IF;
  ELSIF TG_TABLE_NAME='insurance_applications' THEN
    IF OLD.status='pending' AND NEW.status IN ('approved','declined') THEN
      UPDATE public.review_file_cleanup_queue
        SET decision_at=v_decision_at,delete_after=v_decision_at+interval '5 minutes',last_error=NULL
        WHERE bucket_id='insurance'
          AND (
            object_path=ANY(NEW.bank_statement_paths)
            OR object_path=NEW.payslip_path
            OR object_path=NEW.id_copy_path
          )
          AND deleted_at IS NULL;
    END IF;
  ELSIF TG_TABLE_NAME='insurance_claims' THEN
    IF OLD.status='pending' AND NEW.status IN ('approved','declined') THEN
      UPDATE public.review_file_cleanup_queue
        SET decision_at=v_decision_at,delete_after=v_decision_at+interval '5 minutes',last_error=NULL
        WHERE bucket_id='insurance' AND object_path=NEW.quotation_path
          AND deleted_at IS NULL;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

