-- Daily comprehensive midnight administrative PDF report queue and collector.
-- Runs at 00:00 SAST (22:00 UTC) every day.
CREATE TABLE IF NOT EXISTS public.admin_daily_report_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  report_date date NOT NULL UNIQUE,
  report_data jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'sent', 'failed')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz,
  sent_at timestamptz,
  provider_message_id text,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS admin_daily_report_runs_pending_idx
  ON public.admin_daily_report_runs (next_attempt_at, created_at)
  WHERE status IN ('pending', 'processing');

ALTER TABLE public.admin_daily_report_runs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.admin_daily_report_runs FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.admin_daily_report_runs TO service_role;

-- Function to collect 24h daily metrics for the midnight report
CREATE OR REPLACE FUNCTION public.claim_admin_daily_report()
RETURNS TABLE (
  report_id uuid,
  report_date text,
  metrics jsonb
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_report_date date := ((now() AT TIME ZONE 'Africa/Johannesburg')::date);
  v_start_time timestamptz := ((v_report_date - 1)::timestamp AT TIME ZONE 'Africa/Johannesburg');
  v_end_time timestamptz := (v_report_date::timestamp AT TIME ZONE 'Africa/Johannesburg');
  v_run public.admin_daily_report_runs%ROWTYPE;
  v_data jsonb;
BEGIN
  -- Gather metrics
  SELECT jsonb_build_object(
    'date', v_report_date,
    'windowStart', v_start_time,
    'windowEnd', v_end_time,
    -- Total counts
    'totalUsers', (SELECT count(*) FROM public.profiles),
    'totalAuthUsers', (SELECT count(*) FROM auth.users),
    -- Active Growth cycles
    'usersWithActiveCycles', (SELECT count(DISTINCT user_id) FROM public.deposit_tranches WHERE status = 'locked' AND remaining > 0),
    'totalActiveCycles', (SELECT count(*) FROM public.deposit_tranches WHERE status = 'locked' AND remaining > 0),
    'totalGrowingVolumeZAR', (SELECT COALESCE(sum(current_balance), 0) FROM public.deposit_tranches WHERE status = 'locked' AND currency = 'ZAR' AND remaining > 0),
    -- New accounts created in 24h
    'newAccountsCount', (SELECT count(*) FROM public.profiles WHERE created_at >= v_start_time AND created_at < v_end_time),
    'newAccounts', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'accountId', p.account_id,
        'name', trim(concat_ws(' ', p.first_name, p.surname)),
        'email', p.email,
        'phone', p.phone,
        'createdAt', p.created_at
      ) ORDER BY p.created_at DESC), '[]'::jsonb)
      FROM public.profiles p
      WHERE p.created_at >= v_start_time AND p.created_at < v_end_time
    ),
    -- Logins / Active user presence in 24h
    'activeLoggedInCount', (SELECT count(DISTINCT user_id) FROM public.user_presence WHERE last_seen_at >= v_start_time AND last_seen_at < v_end_time),
    'activeLoggedInUsers', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'accountId', p.account_id,
        'name', trim(concat_ws(' ', p.first_name, p.surname)),
        'email', p.email,
        'lastSeenAt', up.last_seen_at
      ) ORDER BY up.last_seen_at DESC), '[]'::jsonb)
      FROM public.user_presence up
      JOIN public.profiles p ON p.id = up.user_id
      WHERE up.last_seen_at >= v_start_time AND up.last_seen_at < v_end_time
    ),
    -- Deposits in 24h
    'depositsCount', (SELECT count(*) FROM public.transactions WHERE type = 'deposit' AND created_at >= v_start_time AND created_at < v_end_time),
    'depositsTotalZAR', (SELECT COALESCE(sum(amount), 0) FROM public.transactions WHERE type = 'deposit' AND status = 'completed' AND currency = 'ZAR' AND created_at >= v_start_time AND created_at < v_end_time),
    'depositsList', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'id', t.id,
        'accountId', p.account_id,
        'name', trim(concat_ws(' ', p.first_name, p.surname)),
        'amount', t.amount,
        'currency', t.currency,
        'status', t.status,
        'reference', t.reference,
        'createdAt', t.created_at
      ) ORDER BY t.created_at DESC), '[]'::jsonb)
      FROM public.transactions t
      JOIN public.profiles p ON p.id = t.user_id
      WHERE t.type = 'deposit' AND t.created_at >= v_start_time AND t.created_at < v_end_time
    ),
    -- Withdrawals in 24h
    'withdrawalsCount', (SELECT count(*) FROM public.transactions WHERE type = 'withdrawal' AND created_at >= v_start_time AND created_at < v_end_time),
    'withdrawalsTotalZAR', (SELECT COALESCE(sum(amount), 0) FROM public.transactions WHERE type = 'withdrawal' AND status = 'completed' AND currency = 'ZAR' AND created_at >= v_start_time AND created_at < v_end_time),
    -- KYC & Welcome bonus in 24h
    'welcomeBonusCreditedCount', (SELECT count(*) FROM public.profiles WHERE welcome_bonus_credited_at >= v_start_time AND welcome_bonus_credited_at < v_end_time)
  ) INTO v_data;

  INSERT INTO public.admin_daily_report_runs (report_date, report_data)
  VALUES (v_report_date, v_data)
  ON CONFLICT (report_date) DO UPDATE
    SET report_data = EXCLUDED.report_data
    WHERE admin_daily_report_runs.status IN ('pending', 'failed');

  SELECT * INTO v_run
  FROM public.admin_daily_report_runs r
  WHERE r.report_date = v_report_date
    AND ((r.status = 'pending' AND r.next_attempt_at <= now())
      OR (r.status = 'processing' AND r.locked_at < now() - interval '10 minutes'))
  FOR UPDATE SKIP LOCKED;

  IF NOT FOUND THEN RETURN; END IF;

  UPDATE public.admin_daily_report_runs
  SET status = 'processing',
      attempts = attempts + 1,
      locked_at = now(),
      last_error = NULL
  WHERE id = v_run.id;

  RETURN QUERY SELECT v_run.id, v_report_date::text, v_data;
END;
$$;

-- Complete report run
CREATE OR REPLACE FUNCTION public.complete_admin_daily_report(
  p_report_id uuid,
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
  UPDATE public.admin_daily_report_runs
  SET status = CASE WHEN p_success THEN 'sent' WHEN attempts >= 8 THEN 'failed' ELSE 'pending' END,
      sent_at = CASE WHEN p_success THEN now() ELSE NULL END,
      provider_message_id = CASE WHEN p_success THEN left(COALESCE(p_provider_message_id, ''), 200) ELSE provider_message_id END,
      last_error = CASE WHEN p_success THEN NULL ELSE left(COALESCE(p_error, 'Daily report failed'), 500) END,
      next_attempt_at = CASE WHEN p_success THEN next_attempt_at ELSE now() + interval '5 minutes' END,
      locked_at = NULL
  WHERE id = p_report_id AND status = 'processing';
END;
$$;

REVOKE ALL ON FUNCTION public.claim_admin_daily_report() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.complete_admin_daily_report(uuid, boolean, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_admin_daily_report() TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_admin_daily_report(uuid, boolean, text, text) TO service_role;
