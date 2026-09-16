-- WhatsApp delivery has independent state so provider retries never resend SMS.
ALTER TABLE public.withdrawable_credit_email_queue
  ADD COLUMN IF NOT EXISTS whatsapp_status text,
  ADD COLUMN IF NOT EXISTS whatsapp_attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS whatsapp_next_attempt_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS whatsapp_locked_at timestamptz,
  ADD COLUMN IF NOT EXISTS whatsapp_sent_at timestamptz,
  ADD COLUMN IF NOT EXISTS whatsapp_provider_message_id text,
  ADD COLUMN IF NOT EXISTS whatsapp_last_error text;

UPDATE public.withdrawable_credit_email_queue
SET whatsapp_status = 'skipped'
WHERE whatsapp_status IS NULL;

ALTER TABLE public.withdrawable_credit_email_queue
  ALTER COLUMN whatsapp_status SET DEFAULT 'pending',
  ALTER COLUMN whatsapp_status SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.withdrawable_credit_email_queue'::regclass
      AND conname = 'withdrawable_credit_whatsapp_status_check'
  ) THEN
    ALTER TABLE public.withdrawable_credit_email_queue
      ADD CONSTRAINT withdrawable_credit_whatsapp_status_check
      CHECK (whatsapp_status IN ('pending', 'processing', 'sent', 'failed', 'skipped'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.withdrawable_credit_email_queue'::regclass
      AND conname = 'withdrawable_credit_whatsapp_attempts_check'
  ) THEN
    ALTER TABLE public.withdrawable_credit_email_queue
      ADD CONSTRAINT withdrawable_credit_whatsapp_attempts_check
      CHECK (whatsapp_attempts >= 0);
  END IF;
END;
$$;

CREATE INDEX IF NOT EXISTS withdrawable_credit_whatsapp_pending_idx
  ON public.withdrawable_credit_email_queue (whatsapp_next_attempt_at, created_at)
  WHERE whatsapp_status IN ('pending', 'processing');

CREATE OR REPLACE FUNCTION public.enqueue_fund_notification(
  p_event_key text,
  p_user_id uuid,
  p_currency text,
  p_amount numeric,
  p_reason text,
  p_notification_kind text DEFAULT 'withdrawable_credit',
  p_cycle_label text DEFAULT NULL,
  p_maturity_date timestamptz DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_email text;
  v_name text;
  v_phone text;
  v_amount numeric := round(p_amount, 2);
  v_sms_status text;
  v_whatsapp_status text;
BEGIN
  IF p_currency NOT IN ('ZAR', 'USD')
     OR v_amount < 0.01
     OR p_notification_kind NOT IN ('withdrawable_credit', 'deposit_approved') THEN
    RETURN;
  END IF;

  SELECT lower(trim(u.email)), NULLIF(trim(p.first_name), ''), NULLIF(trim(p.phone), '')
  INTO v_email, v_name, v_phone
  FROM auth.users u
  LEFT JOIN public.profiles p ON p.id = u.id
  WHERE u.id = p_user_id;

  IF v_email IS NULL OR length(v_email) < 3 THEN RETURN; END IF;
  v_sms_status := CASE WHEN length(COALESCE(v_phone, '')) >= 8 THEN 'pending' ELSE 'skipped' END;
  v_whatsapp_status := CASE WHEN length(COALESCE(v_phone, '')) >= 8 THEN 'pending' ELSE 'skipped' END;

  INSERT INTO public.withdrawable_credit_email_queue (
    event_key, user_id, recipient_email, recipient_name, recipient_phone,
    currency, amount, reason, notification_kind, cycle_label, maturity_date,
    next_attempt_at, sms_status, sms_next_attempt_at,
    whatsapp_status, whatsapp_next_attempt_at
  ) VALUES (
    left(p_event_key, 200), p_user_id, v_email, v_name, v_phone,
    p_currency, v_amount,
    left(COALESCE(NULLIF(trim(p_reason), ''), 'Funds credited'), 300),
    p_notification_kind, NULLIF(left(trim(COALESCE(p_cycle_label, '')), 100), ''),
    p_maturity_date, now() + interval '30 seconds', v_sms_status, now() + interval '30 seconds',
    v_whatsapp_status, now() + interval '30 seconds'
  )
  ON CONFLICT (event_key) DO NOTHING;
END;
$$;

CREATE OR REPLACE FUNCTION public.claim_fund_notification_whatsapp(p_limit integer DEFAULT 20)
RETURNS TABLE (
  notification_id uuid,
  recipient_phone text,
  recipient_name text,
  currency text,
  amount numeric,
  reason text,
  event_key text,
  event_created_at timestamptz,
  notification_kind text,
  cycle_label text,
  maturity_date timestamptz
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  WITH candidates AS (
    SELECT q.id
    FROM public.withdrawable_credit_email_queue q
    WHERE q.recipient_phone IS NOT NULL
      AND ((q.whatsapp_status = 'pending' AND q.whatsapp_next_attempt_at <= now())
        OR (q.whatsapp_status = 'processing' AND q.whatsapp_locked_at < now() - interval '10 minutes'))
    ORDER BY q.created_at
    FOR UPDATE SKIP LOCKED
    LIMIT least(greatest(COALESCE(p_limit, 20), 1), 50)
  ), claimed AS (
    UPDATE public.withdrawable_credit_email_queue q
    SET whatsapp_status = 'processing', whatsapp_attempts = q.whatsapp_attempts + 1,
        whatsapp_locked_at = now(), whatsapp_last_error = NULL
    FROM candidates c
    WHERE q.id = c.id
    RETURNING q.*
  )
  SELECT c.id, c.recipient_phone, c.recipient_name, c.currency, c.amount,
         c.reason, c.event_key, c.created_at, c.notification_kind,
         c.cycle_label, c.maturity_date
  FROM claimed c
  ORDER BY c.created_at;
$$;

CREATE OR REPLACE FUNCTION public.complete_fund_notification_whatsapp(
  p_notification_id uuid,
  p_success boolean,
  p_provider_message_id text DEFAULT NULL,
  p_error text DEFAULT NULL,
  p_permanent_failure boolean DEFAULT false
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.withdrawable_credit_email_queue q
  SET whatsapp_status = CASE
        WHEN p_success THEN 'sent'
        WHEN p_permanent_failure THEN 'failed'
        WHEN q.whatsapp_attempts >= 8 THEN 'failed'
        ELSE 'pending'
      END,
      whatsapp_sent_at = CASE WHEN p_success THEN now() ELSE NULL END,
      whatsapp_provider_message_id = CASE
        WHEN p_success THEN left(COALESCE(p_provider_message_id, ''), 200)
        ELSE q.whatsapp_provider_message_id
      END,
      whatsapp_last_error = CASE
        WHEN p_success THEN NULL
        ELSE left(COALESCE(p_error, 'WhatsApp delivery failed'), 500)
      END,
      whatsapp_next_attempt_at = CASE
        WHEN p_success THEN q.whatsapp_next_attempt_at
        ELSE now() + interval '5 minutes'
      END,
      whatsapp_locked_at = NULL
  WHERE q.id = p_notification_id AND q.whatsapp_status = 'processing';
END;
$$;

REVOKE ALL ON FUNCTION public.claim_fund_notification_whatsapp(integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.complete_fund_notification_whatsapp(uuid, boolean, text, text, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_fund_notification_whatsapp(integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_fund_notification_whatsapp(uuid, boolean, text, text, boolean) TO service_role;