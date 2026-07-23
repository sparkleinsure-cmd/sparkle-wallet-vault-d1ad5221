-- Track administrator views separately from review decisions. A file is only
-- eligible for removal when both happened, and remains available for a
-- five-minute grace period after the final decision.
CREATE TABLE IF NOT EXISTS public.review_file_cleanup_queue (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bucket_id text NOT NULL CHECK (bucket_id IN ('deposits','kyc','insurance')),
  object_path text NOT NULL CHECK (length(object_path) BETWEEN 3 AND 500),
  viewed_at timestamptz NOT NULL DEFAULT now(),
  viewed_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  decision_at timestamptz,
  delete_after timestamptz,
  deleted_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(bucket_id,object_path)
);

CREATE INDEX IF NOT EXISTS review_file_cleanup_due_idx
  ON public.review_file_cleanup_queue(delete_after)
  WHERE deleted_at IS NULL AND delete_after IS NOT NULL;

ALTER TABLE public.review_file_cleanup_queue ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.review_file_cleanup_queue FROM PUBLIC,anon,authenticated;
GRANT ALL ON public.review_file_cleanup_queue TO service_role;

CREATE OR REPLACE FUNCTION public.schedule_review_file_cleanup()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=public
AS $$
DECLARE v_decision_at timestamptz := now();
BEGIN
  IF TG_TABLE_NAME='transactions' AND NEW.type='deposit'
     AND OLD.status='pending' AND NEW.status IN ('completed','declined') THEN
    UPDATE public.review_file_cleanup_queue
      SET decision_at=v_decision_at,delete_after=v_decision_at+interval '5 minutes',last_error=NULL
      WHERE bucket_id='deposits' AND object_path=NEW.proof_url
        AND deleted_at IS NULL;
  ELSIF TG_TABLE_NAME='profiles'
     AND OLD.kyc_status='pending' AND NEW.kyc_status IN ('verified','rejected') THEN
    UPDATE public.review_file_cleanup_queue
      SET decision_at=v_decision_at,delete_after=v_decision_at+interval '5 minutes',last_error=NULL
      WHERE bucket_id='kyc' AND object_path IN (NEW.proof_url,NEW.selfie_url)
        AND deleted_at IS NULL;
  ELSIF TG_TABLE_NAME='insurance_applications'
     AND OLD.status='pending' AND NEW.status IN ('approved','declined') THEN
    UPDATE public.review_file_cleanup_queue
      SET decision_at=v_decision_at,delete_after=v_decision_at+interval '5 minutes',last_error=NULL
      WHERE bucket_id='insurance'
        AND (
          object_path=ANY(NEW.bank_statement_paths)
          OR object_path=NEW.payslip_path
          OR object_path=NEW.id_copy_path
        )
        AND deleted_at IS NULL;
  ELSIF TG_TABLE_NAME='insurance_claims'
     AND OLD.status='pending' AND NEW.status IN ('approved','declined') THEN
    UPDATE public.review_file_cleanup_queue
      SET decision_at=v_decision_at,delete_after=v_decision_at+interval '5 minutes',last_error=NULL
      WHERE bucket_id='insurance' AND object_path=NEW.quotation_path
        AND deleted_at IS NULL;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS schedule_deposit_file_cleanup ON public.transactions;
CREATE TRIGGER schedule_deposit_file_cleanup
AFTER UPDATE OF status ON public.transactions
FOR EACH ROW EXECUTE FUNCTION public.schedule_review_file_cleanup();

DROP TRIGGER IF EXISTS schedule_kyc_file_cleanup ON public.profiles;
CREATE TRIGGER schedule_kyc_file_cleanup
AFTER UPDATE OF kyc_status ON public.profiles
FOR EACH ROW EXECUTE FUNCTION public.schedule_review_file_cleanup();

DROP TRIGGER IF EXISTS schedule_insurance_application_file_cleanup ON public.insurance_applications;
CREATE TRIGGER schedule_insurance_application_file_cleanup
AFTER UPDATE OF status ON public.insurance_applications
FOR EACH ROW EXECUTE FUNCTION public.schedule_review_file_cleanup();

DROP TRIGGER IF EXISTS schedule_insurance_claim_file_cleanup ON public.insurance_claims;
CREATE TRIGGER schedule_insurance_claim_file_cleanup
AFTER UPDATE OF status ON public.insurance_claims
FOR EACH ROW EXECUTE FUNCTION public.schedule_review_file_cleanup();

REVOKE ALL ON FUNCTION public.schedule_review_file_cleanup() FROM PUBLIC,anon,authenticated;

CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;

-- This worker is intentionally safe to invoke without a user JWT: callers
-- cannot provide paths or alter the queue, and it only processes server-
-- authorized rows whose grace period has already expired.
DO $$
DECLARE existing_job bigint;
BEGIN
  FOR existing_job IN
    SELECT jobid FROM cron.job WHERE jobname='review-storage-cleanup-every-minute'
  LOOP
    PERFORM cron.unschedule(existing_job);
  END LOOP;
  PERFORM cron.schedule(
    'review-storage-cleanup-every-minute',
    '* * * * *',
    $job$
      SELECT net.http_post(
        url := 'https://jrqrpjdlhzzfanqwinct.supabase.co/functions/v1/storage-cleanup',
        headers := '{"Content-Type":"application/json"}'::jsonb,
        body := '{}'::jsonb,
        timeout_milliseconds := 10000
      );
    $job$
  );
END $$;
