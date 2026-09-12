-- Keep the existing selfie-only welcome-bonus flow. Face detection runs in
-- the member's browser with bundled assets; a detected face is auto-approved,
-- while no-face or unavailable detection remains in the existing admin queue.
CREATE TABLE IF NOT EXISTS public.kyc_face_screenings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  selfie_path text NOT NULL CHECK (length(selfie_path) BETWEEN 3 AND 500),
  face_detected boolean NOT NULL,
  confidence numeric CHECK (confidence IS NULL OR confidence BETWEEN 0 AND 1),
  detector_version text NOT NULL
    CHECK (detector_version IN ('mediapipe-blazeface-short-range-v1', 'unavailable')),
  decision text NOT NULL CHECK (decision IN ('auto_approved', 'admin_review')),
  bonus_credited_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS kyc_face_screenings_user_idx
  ON public.kyc_face_screenings (user_id, created_at DESC);

ALTER TABLE public.kyc_face_screenings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.kyc_face_screenings FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.kyc_face_screenings TO service_role;

CREATE TABLE IF NOT EXISTS public.admin_auto_approval_email_queue (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type text NOT NULL CHECK (event_type IN ('welcome_bonus', 'recruiter')),
  subject_user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  related_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'sent', 'failed')),
  batch_id uuid,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz,
  sent_at timestamptz,
  provider_message_id text,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (event_type, related_id)
);

CREATE INDEX IF NOT EXISTS admin_auto_approval_email_pending_idx
  ON public.admin_auto_approval_email_queue (next_attempt_at, created_at)
  WHERE status IN ('pending', 'processing');

ALTER TABLE public.admin_auto_approval_email_queue ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.admin_auto_approval_email_queue FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.admin_auto_approval_email_queue TO service_role;

CREATE OR REPLACE FUNCTION public.submit_kyc_review_auto(
  p_selfie_path text,
  p_face_detected boolean,
  p_face_confidence numeric,
  p_detector_version text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=public
AS $$
DECLARE
  v_profile public.profiles%ROWTYPE;
  v_status public.kyc_status;
  v_credited_at timestamptz;
  v_screening_id uuid;
BEGIN
  IF auth.uid() IS NULL OR length(trim(COALESCE(p_selfie_path,'')))<3
     OR split_part(p_selfie_path,'/',1)<>auth.uid()::text THEN
    RAISE EXCEPTION 'Invalid verification submission';
  END IF;
  IF p_detector_version NOT IN ('mediapipe-blazeface-short-range-v1','unavailable') THEN
    RAISE EXCEPTION 'Invalid face detector';
  END IF;
  IF p_face_confidence IS NOT NULL AND (p_face_confidence<0 OR p_face_confidence>1) THEN
    RAISE EXCEPTION 'Invalid face confidence';
  END IF;
  IF p_face_detected IS TRUE AND p_detector_version<>'mediapipe-blazeface-short-range-v1' THEN
    RAISE EXCEPTION 'Invalid face detection result';
  END IF;
  IF p_face_detected IS NOT TRUE THEN
    p_face_detected:=false;
    p_face_confidence:=NULL;
  END IF;

  SELECT * INTO v_profile FROM public.profiles WHERE id=auth.uid() FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Profile not found'; END IF;

  -- Preserve all existing welcome-bonus anti-repeat rules. This replaces the
  -- old submit function's gate while allowing a better selfie to be resubmitted.
  IF v_profile.welcome_bonus_credited_at IS NOT NULL OR EXISTS (
    SELECT 1
    FROM public.signup_risk_signals s
    JOIN public.signup_identity_history h
      ON h.signal_type=s.signal_type AND h.signal_hash=s.signal_hash
    WHERE s.user_id=auth.uid() AND h.bonus_claimed_at IS NOT NULL
      AND (
        s.signal_type IN ('email','phone')
        OR (s.signal_type='installation' AND NOT EXISTS (
          SELECT 1 FROM public.bonus_test_installations t WHERE t.signal_hash=s.signal_hash
        ))
      )
  ) THEN
    RAISE EXCEPTION 'Welcome bonus already claimed';
  END IF;

  v_status:=CASE WHEN p_face_detected
    THEN 'verified'::public.kyc_status ELSE 'pending'::public.kyc_status END;
  UPDATE public.profiles
  SET selfie_url=p_selfie_path,kyc_status=v_status
  WHERE id=auth.uid();

  IF p_face_detected THEN
    v_credited_at:=public.credit_welcome_bonus_if_eligible(auth.uid());
  END IF;

  INSERT INTO public.kyc_face_screenings(
    user_id,selfie_path,face_detected,confidence,detector_version,
    decision,bonus_credited_at
  ) VALUES(
    auth.uid(),p_selfie_path,p_face_detected,p_face_confidence,p_detector_version,
    CASE WHEN p_face_detected THEN 'auto_approved' ELSE 'admin_review' END,
    v_credited_at
  ) RETURNING id INTO v_screening_id;

  IF v_credited_at IS NOT NULL THEN
    INSERT INTO public.admin_auto_approval_email_queue(event_type,subject_user_id,related_id)
    VALUES('welcome_bonus',auth.uid(),v_screening_id)
    ON CONFLICT(event_type,related_id) DO NOTHING;
  END IF;

  RETURN jsonb_build_object(
    'ok',true,'status',v_status::text,'faceDetected',p_face_detected,
    'bonusCredited',v_credited_at IS NOT NULL,'bonusCreditedAt',v_credited_at
  );
END;
$$;

-- Agreement acceptance, the declaration and valid registered banking details
-- are the full criteria, so a qualifying recruiter becomes active immediately.
CREATE OR REPLACE FUNCTION public.submit_my_recruiter_application(
  p_agreement_version text,
  p_declaration_accepted boolean
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=public
AS $$
DECLARE
  v_profile public.profiles%ROWTYPE;
  v_application public.recruiter_applications%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Unauthorized'; END IF;
  IF p_declaration_accepted IS NOT TRUE THEN
    RAISE EXCEPTION 'Accept the recruiter agreement and declaration to apply';
  END IF;
  IF trim(COALESCE(p_agreement_version,''))<>'recruiter-v1-2026-09-03' THEN
    RAISE EXCEPTION 'Refresh the page and accept the current recruiter agreement';
  END IF;

  SELECT * INTO v_profile FROM public.profiles WHERE id=auth.uid() FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Profile not found'; END IF;
  IF length(trim(COALESCE(v_profile.bank_name,'')))<2
     OR trim(COALESCE(v_profile.bank_account_number,''))!~'^[0-9]{4,40}$' THEN
    RAISE EXCEPTION 'Add your registered banking details before applying';
  END IF;

  SELECT * INTO v_application
  FROM public.recruiter_applications WHERE user_id=auth.uid() FOR UPDATE;
  IF FOUND AND v_application.status IN ('pending','approved','suspended') THEN
    RAISE EXCEPTION 'A recruiter application is already active for this account';
  END IF;

  INSERT INTO public.recruiter_applications(
    user_id,status,agreement_version,declaration_accepted_at,
    bank_name_snapshot,bank_account_last4,applied_at,approved_at,
    reviewed_at,reviewed_by,review_note,updated_at
  ) VALUES(
    auth.uid(),'approved',trim(p_agreement_version),now(),
    trim(v_profile.bank_name),right(trim(v_profile.bank_account_number),4),now(),now(),
    now(),NULL,'Automatically approved after agreement and declaration acceptance',now()
  )
  ON CONFLICT(user_id) DO UPDATE SET
    status='approved',agreement_version=EXCLUDED.agreement_version,
    declaration_accepted_at=EXCLUDED.declaration_accepted_at,
    bank_name_snapshot=EXCLUDED.bank_name_snapshot,
    bank_account_last4=EXCLUDED.bank_account_last4,applied_at=EXCLUDED.applied_at,
    approved_at=EXCLUDED.approved_at,reviewed_at=EXCLUDED.reviewed_at,
    reviewed_by=NULL,review_note=EXCLUDED.review_note,updated_at=now()
  RETURNING * INTO v_application;

  INSERT INTO public.admin_auto_approval_email_queue(event_type,subject_user_id,related_id)
  VALUES('recruiter',auth.uid(),v_application.id)
  ON CONFLICT(event_type,related_id) DO NOTHING;
  RETURN v_application.id;
END;
$$;

-- Existing pending applications already contain the same agreement,
-- declaration timestamp and banking snapshots, so apply the new rule to them.
WITH approved AS (
  UPDATE public.recruiter_applications
  SET status='approved',approved_at=COALESCE(approved_at,now()),reviewed_at=now(),
      reviewed_by=NULL,
      review_note='Automatically approved after agreement and declaration acceptance',
      updated_at=now()
  WHERE status='pending'
  RETURNING id,user_id
)
INSERT INTO public.admin_auto_approval_email_queue(event_type,subject_user_id,related_id)
SELECT 'recruiter',user_id,id FROM approved
ON CONFLICT(event_type,related_id) DO NOTHING;

CREATE OR REPLACE FUNCTION public.claim_admin_auto_approval_digest(p_limit integer DEFAULT 100)
RETURNS TABLE(batch_id uuid,notification_ids uuid[],events jsonb)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=public
AS $$
DECLARE v_batch_id uuid;
BEGIN
  SELECT q.batch_id INTO v_batch_id
  FROM public.admin_auto_approval_email_queue q
  WHERE q.batch_id IS NOT NULL AND (
    (q.status='pending' AND q.next_attempt_at<=now())
    OR (q.status='processing' AND q.locked_at<now()-interval '10 minutes')
  ) ORDER BY q.created_at LIMIT 1;

  v_batch_id:=COALESCE(v_batch_id,gen_random_uuid());
  RETURN QUERY
  WITH candidates AS (
    SELECT q.id
    FROM public.admin_auto_approval_email_queue q
    WHERE ((q.batch_id=v_batch_id) OR (q.batch_id IS NULL AND NOT EXISTS (
      SELECT 1 FROM public.admin_auto_approval_email_queue existing
      WHERE existing.batch_id=v_batch_id
    ))) AND (
      (q.status='pending' AND q.next_attempt_at<=now())
      OR (q.status='processing' AND q.locked_at<now()-interval '10 minutes')
    )
    ORDER BY q.created_at FOR UPDATE SKIP LOCKED
    LIMIT least(greatest(COALESCE(p_limit,100),1),200)
  ), claimed AS (
    UPDATE public.admin_auto_approval_email_queue q
    SET status='processing',batch_id=v_batch_id,attempts=q.attempts+1,
        locked_at=now(),last_error=NULL
    FROM candidates c WHERE q.id=c.id RETURNING q.*
  )
  SELECT v_batch_id,
    COALESCE(array_agg(c.id ORDER BY c.created_at),'{}'::uuid[]),
    COALESCE(jsonb_agg(jsonb_build_object(
      'eventType',c.event_type,'occurredAt',c.created_at,'accountId',p.account_id,
      'userName',COALESCE(NULLIF(concat_ws(' ',NULLIF(trim(p.first_name),''),NULLIF(trim(p.surname),'')),''),'Unknown user'),
      'userEmail',p.email,'userPhone',p.phone
    ) ORDER BY c.created_at),'[]'::jsonb)
  FROM claimed c LEFT JOIN public.profiles p ON p.id=c.subject_user_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.complete_admin_auto_approval_digest(
  p_notification_ids uuid[],p_success boolean,
  p_provider_message_id text DEFAULT NULL,p_error text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=public
AS $$
BEGIN
  UPDATE public.admin_auto_approval_email_queue q
  SET status=CASE WHEN p_success THEN 'sent' WHEN q.attempts>=8 THEN 'failed' ELSE 'pending' END,
      sent_at=CASE WHEN p_success THEN now() ELSE NULL END,
      provider_message_id=CASE WHEN p_success THEN left(COALESCE(p_provider_message_id,''),200) ELSE q.provider_message_id END,
      last_error=CASE WHEN p_success THEN NULL ELSE left(COALESCE(p_error,'Admin approval digest delivery failed'),500) END,
      next_attempt_at=CASE WHEN p_success THEN q.next_attempt_at ELSE now()+interval '5 minutes' END,
      locked_at=NULL
  WHERE q.id=ANY(COALESCE(p_notification_ids,'{}'::uuid[])) AND q.status='processing';
END;
$$;

REVOKE ALL ON FUNCTION public.submit_kyc_review_auto(text,boolean,numeric,text)
  FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.submit_kyc_review_auto(text,boolean,numeric,text)
  TO authenticated;
REVOKE ALL ON FUNCTION public.claim_admin_auto_approval_digest(integer)
  FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.complete_admin_auto_approval_digest(uuid[],boolean,text,text)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.claim_admin_auto_approval_digest(integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_admin_auto_approval_digest(uuid[],boolean,text,text) TO service_role;

CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;
DO $$
DECLARE v_job bigint;
BEGIN
  -- A single sequential worker avoids concurrent minute-boundary database
  -- claims from the deposit and auto-approval notification queues.
  FOR v_job IN SELECT jobid FROM cron.job WHERE jobname IN (
    'admin-pending-deposit-email-every-minute',
    'admin-auto-approval-email-every-minute',
    'admin-routine-email-every-minute'
  )
  LOOP PERFORM cron.unschedule(v_job); END LOOP;
  PERFORM cron.schedule(
    'admin-routine-email-every-minute','* * * * *',
    $job$
      SELECT net.http_post(
        url := 'https://jrqrpjdlhzzfanqwinct.supabase.co/functions/v1/admin-maturity-alert-email',
        headers := '{"Content-Type":"application/json"}'::jsonb,
        body := '{"kind":"routine"}'::jsonb,
        timeout_milliseconds := 30000
      );
    $job$
  );
END;
$$;
