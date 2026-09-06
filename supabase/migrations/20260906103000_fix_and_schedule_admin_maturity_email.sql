-- Isolate the admin maturity digest from the member email/SMS worker and run
-- it once daily at exactly 00:00 SAST (22:00 UTC). South Africa does not use
-- daylight-saving time, so this UTC schedule remains stable year-round.

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
  ON CONFLICT ON CONSTRAINT admin_maturity_alert_email_runs_alert_date_key
  DO NOTHING;

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

REVOKE ALL ON FUNCTION public.claim_admin_maturity_alert_email()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_admin_maturity_alert_email() TO service_role;

CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;

DO $$
DECLARE v_job bigint;
BEGIN
  FOR v_job IN
    SELECT jobid FROM cron.job
    WHERE jobname = 'admin-maturity-alert-email-midnight-sast'
  LOOP
    PERFORM cron.unschedule(v_job);
  END LOOP;

  PERFORM cron.schedule(
    'admin-maturity-alert-email-midnight-sast',
    '0 22 * * *',
    $job$
      SELECT net.http_post(
        url := 'https://jrqrpjdlhzzfanqwinct.supabase.co/functions/v1/admin-maturity-alert-email',
        headers := '{"Content-Type":"application/json"}'::jsonb,
        body := '{}'::jsonb,
        timeout_milliseconds := 30000
      );
    $job$
  );
END;
$$;
