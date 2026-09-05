-- Send administrators one daily digest while approved locked tranches are
-- overdue or approaching maturity within five days. Delivery uses the
-- existing Resend notification worker and is retry-safe.
CREATE TABLE IF NOT EXISTS public.admin_maturity_alert_email_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  alert_date date NOT NULL UNIQUE,
  window_end timestamptz NOT NULL,
  tranche_count integer NOT NULL CHECK (tranche_count > 0),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'sent', 'failed')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz,
  sent_at timestamptz,
  provider_message_id text,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS admin_maturity_alert_email_pending_idx
  ON public.admin_maturity_alert_email_runs (next_attempt_at, created_at)
  WHERE status IN ('pending', 'processing');

ALTER TABLE public.admin_maturity_alert_email_runs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.admin_maturity_alert_email_runs FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.admin_maturity_alert_email_runs TO service_role;

CREATE OR REPLACE FUNCTION public.claim_admin_maturity_alert_email()
RETURNS TABLE (
  notification_id uuid,
  alert_date date,
  maturity_window_end timestamptz,
  tranche_count integer,
  tranches jsonb
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_alert_date date := (now() AT TIME ZONE 'Africa/Johannesburg')::date;
  v_window_end timestamptz := now() + interval '5 days';
  v_due_count integer;
  v_run public.admin_maturity_alert_email_runs%ROWTYPE;
  v_tranches jsonb;
BEGIN
  SELECT count(*)::integer
  INTO v_due_count
  FROM public.deposit_tranches t
  WHERE t.status = 'locked'
    AND t.approved = true
    AND t.remaining > 0
    AND t.maturity_date <= v_window_end;

  IF v_due_count = 0 THEN
    RETURN;
  END IF;

  INSERT INTO public.admin_maturity_alert_email_runs (
    alert_date, window_end, tranche_count
  ) VALUES (
    v_alert_date, v_window_end, v_due_count
  )
  ON CONFLICT (alert_date) DO NOTHING;

  SELECT r.*
  INTO v_run
  FROM public.admin_maturity_alert_email_runs r
  WHERE r.alert_date = v_alert_date
    AND (
      (r.status = 'pending' AND r.next_attempt_at <= now())
      OR (r.status = 'processing' AND r.locked_at < now() - interval '10 minutes')
    )
  FOR UPDATE SKIP LOCKED;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  UPDATE public.admin_maturity_alert_email_runs r
  SET status = 'processing',
      attempts = r.attempts + 1,
      locked_at = now(),
      last_error = NULL,
      window_end = v_window_end,
      tranche_count = v_due_count
  WHERE r.id = v_run.id
  RETURNING r.* INTO v_run;

  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'tranche_id', t.id,
        'user_id', t.user_id,
        'account_id', p.account_id,
        'user_name', COALESCE(
          NULLIF(concat_ws(' ', NULLIF(trim(p.first_name), ''), NULLIF(trim(p.surname), '')), ''),
          'Unknown user'
        ),
        'currency', t.currency,
        'current_balance', COALESCE(t.current_balance, t.remaining),
        'cycle_label', COALESCE(t.cycle_label, 'Growth cycle'),
        'maturity_date', t.maturity_date
      )
      ORDER BY t.maturity_date, t.created_at
    ),
    '[]'::jsonb
  )
  INTO v_tranches
  FROM public.deposit_tranches t
  LEFT JOIN public.profiles p ON p.id = t.user_id
  WHERE t.status = 'locked'
    AND t.approved = true
    AND t.remaining > 0
    AND t.maturity_date <= v_window_end;

  RETURN QUERY
  SELECT v_run.id, v_run.alert_date, v_run.window_end,
         v_run.tranche_count, v_tranches;
END;
$$;

CREATE OR REPLACE FUNCTION public.complete_admin_maturity_alert_email(
  p_notification_id uuid,
  p_success boolean,
  p_provider_message_id text DEFAULT NULL,
  p_error text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.admin_maturity_alert_email_runs r
  SET status = CASE
        WHEN p_success THEN 'sent'
        WHEN r.attempts >= 8 THEN 'failed'
        ELSE 'pending'
      END,
      sent_at = CASE WHEN p_success THEN now() ELSE NULL END,
      provider_message_id = CASE
        WHEN p_success THEN left(COALESCE(p_provider_message_id, ''), 200)
        ELSE r.provider_message_id
      END,
      last_error = CASE
        WHEN p_success THEN NULL
        ELSE left(COALESCE(p_error, 'Admin maturity alert delivery failed'), 500)
      END,
      next_attempt_at = CASE
        WHEN p_success THEN r.next_attempt_at
        ELSE now() + interval '15 minutes'
      END,
      locked_at = NULL
  WHERE r.id = p_notification_id
    AND r.status = 'processing';
END;
$$;

REVOKE ALL ON FUNCTION public.claim_admin_maturity_alert_email()
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.complete_admin_maturity_alert_email(uuid, boolean, text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_admin_maturity_alert_email() TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_admin_maturity_alert_email(uuid, boolean, text, text)
  TO service_role;
