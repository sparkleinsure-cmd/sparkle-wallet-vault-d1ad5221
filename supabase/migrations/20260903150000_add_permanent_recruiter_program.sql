-- The permanent recruiter programme is deliberately isolated from the
-- existing friends-and-family referral reward. Existing referrals continue to
-- earn their one-time 10% reward; these tables only track recruiter status,
-- qualification progress, invitations and the separate monthly R3,000 credit.

CREATE TABLE public.recruiter_applications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'declined', 'suspended')),
  agreement_version text NOT NULL CHECK (length(agreement_version) BETWEEN 3 AND 100),
  declaration_accepted_at timestamptz NOT NULL,
  bank_name_snapshot text NOT NULL CHECK (length(bank_name_snapshot) BETWEEN 2 AND 100),
  bank_account_last4 text NOT NULL CHECK (bank_account_last4 ~ '^[0-9]{4}$'),
  applied_at timestamptz NOT NULL DEFAULT now(),
  approved_at timestamptz,
  reviewed_at timestamptz,
  reviewed_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  review_note text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX recruiter_applications_status_idx
  ON public.recruiter_applications (status, applied_at DESC);

CREATE TABLE public.recruiter_invites (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  recruiter_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  invitee_email text NOT NULL CHECK (length(invitee_email) BETWEEN 3 AND 320),
  invitee_first_name text NOT NULL CHECK (length(invitee_first_name) BETWEEN 1 AND 100),
  invitee_surname text NOT NULL CHECK (length(invitee_surname) BETWEEN 1 AND 100),
  invitee_phone text NOT NULL CHECK (length(invitee_phone) BETWEEN 8 AND 30),
  invited_user_id uuid UNIQUE REFERENCES auth.users(id) ON DELETE SET NULL,
  consent_attested_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'sent', 'accepted', 'failed')),
  provider_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz,
  accepted_at timestamptz
);

CREATE UNIQUE INDEX recruiter_invites_email_unique_idx
  ON public.recruiter_invites (lower(invitee_email));
CREATE INDEX recruiter_invites_recruiter_idx
  ON public.recruiter_invites (recruiter_id, created_at DESC);

CREATE TABLE public.recruiter_salary_periods (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  recruiter_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  period_start date NOT NULL,
  period_end date NOT NULL,
  qualifying_recruits integer NOT NULL DEFAULT 0 CHECK (qualifying_recruits >= 0),
  qualifying_deposits numeric(18,2) NOT NULL DEFAULT 0 CHECK (qualifying_deposits >= 0),
  target_amount numeric(18,2) NOT NULL DEFAULT 20000 CHECK (target_amount > 0),
  salary_amount numeric(18,2) NOT NULL DEFAULT 3000 CHECK (salary_amount >= 0),
  status text NOT NULL CHECK (status IN ('processing', 'paid', 'not_qualified')),
  transaction_id uuid UNIQUE REFERENCES public.transactions(id) ON DELETE SET NULL,
  evaluated_at timestamptz NOT NULL DEFAULT now(),
  credited_at timestamptz,
  UNIQUE (recruiter_id, period_start),
  CHECK (period_end >= period_start)
);

CREATE INDEX recruiter_salary_periods_recruiter_idx
  ON public.recruiter_salary_periods (recruiter_id, period_start DESC);

ALTER TABLE public.recruiter_applications ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.recruiter_invites ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.recruiter_salary_periods ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.recruiter_applications FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.recruiter_invites FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.recruiter_salary_periods FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.recruiter_applications TO service_role;
GRANT ALL ON public.recruiter_invites TO service_role;
GRANT ALL ON public.recruiter_salary_periods TO service_role;

-- Assign an approval to its recruiter period in Johannesburg time. The 28th
-- is salary-processing day, so approvals on that date carry into the period
-- beginning on the 29th instead of being discarded.
CREATE OR REPLACE FUNCTION public.recruiter_period_start(p_at timestamptz)
RETURNS date
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
  v_date date := (p_at AT TIME ZONE 'Africa/Johannesburg')::date;
  v_month_start date := date_trunc('month', v_date)::date;
  v_last_day date := (date_trunc('month', v_date) + interval '1 month - 1 day')::date;
BEGIN
  IF extract(day FROM v_date) >= 29 THEN
    RETURN least(v_month_start + 28, v_last_day);
  ELSIF extract(day FROM v_date) = 28 THEN
    RETURN least(v_month_start + 28, v_last_day);
  END IF;
  v_month_start := (v_month_start - interval '1 month')::date;
  v_last_day := (date_trunc('month', v_month_start) + interval '1 month - 1 day')::date;
  RETURN least(v_month_start + 28, v_last_day);
END;
$$;

CREATE OR REPLACE FUNCTION public.submit_my_recruiter_application(
  p_agreement_version text,
  p_declaration_accepted boolean
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_profile public.profiles%ROWTYPE;
  v_application public.recruiter_applications%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Unauthorized'; END IF;
  IF p_declaration_accepted IS NOT TRUE THEN
    RAISE EXCEPTION 'Accept the recruiter agreement and declaration to apply';
  END IF;
  IF trim(COALESCE(p_agreement_version, '')) <> 'recruiter-v1-2026-09-03' THEN
    RAISE EXCEPTION 'Refresh the page and accept the current recruiter agreement';
  END IF;

  SELECT * INTO v_profile FROM public.profiles WHERE id = auth.uid() FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Profile not found'; END IF;
  IF length(trim(COALESCE(v_profile.bank_name, ''))) < 2
     OR trim(COALESCE(v_profile.bank_account_number, '')) !~ '^[0-9]{4,40}$' THEN
    RAISE EXCEPTION 'Add your registered banking details before applying';
  END IF;

  SELECT * INTO v_application
  FROM public.recruiter_applications WHERE user_id = auth.uid() FOR UPDATE;
  IF FOUND AND v_application.status IN ('pending', 'approved', 'suspended') THEN
    RAISE EXCEPTION 'A recruiter application is already active for this account';
  END IF;

  INSERT INTO public.recruiter_applications (
    user_id, status, agreement_version, declaration_accepted_at,
    bank_name_snapshot, bank_account_last4, applied_at, approved_at,
    reviewed_at, reviewed_by, review_note, updated_at
  ) VALUES (
    auth.uid(), 'pending', trim(p_agreement_version), now(),
    trim(v_profile.bank_name), right(trim(v_profile.bank_account_number), 4),
    now(), NULL, NULL, NULL, NULL, now()
  )
  ON CONFLICT (user_id) DO UPDATE SET
    status = 'pending',
    agreement_version = EXCLUDED.agreement_version,
    declaration_accepted_at = EXCLUDED.declaration_accepted_at,
    bank_name_snapshot = EXCLUDED.bank_name_snapshot,
    bank_account_last4 = EXCLUDED.bank_account_last4,
    applied_at = EXCLUDED.applied_at,
    approved_at = NULL,
    reviewed_at = NULL,
    reviewed_by = NULL,
    review_note = NULL,
    updated_at = now()
  RETURNING id INTO v_application.id;

  RETURN v_application.id;
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_review_recruiter_application(
  p_application_id uuid,
  p_status text,
  p_note text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_application public.recruiter_applications%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(), 'admin'::public.app_role) THEN
    RAISE EXCEPTION 'Forbidden';
  END IF;
  IF p_status NOT IN ('approved', 'declined', 'suspended') THEN
    RAISE EXCEPTION 'Invalid recruiter decision';
  END IF;

  SELECT * INTO v_application
  FROM public.recruiter_applications WHERE id = p_application_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Recruiter application not found'; END IF;
  IF v_application.status = p_status THEN RETURN; END IF;
  IF v_application.status <> 'pending'
     AND p_status <> 'suspended'
     AND NOT (v_application.status = 'suspended' AND p_status = 'approved') THEN
    RAISE EXCEPTION 'This recruiter application has already been reviewed';
  END IF;

  UPDATE public.recruiter_applications
  SET status = p_status,
      approved_at = CASE WHEN p_status = 'approved' THEN COALESCE(approved_at, now()) ELSE approved_at END,
      reviewed_at = now(),
      reviewed_by = auth.uid(),
      review_note = NULLIF(left(trim(COALESCE(p_note, '')), 500), ''),
      updated_at = now()
  WHERE id = p_application_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_my_recruiter_dashboard()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_application public.recruiter_applications%ROWTYPE;
  v_period_start date := public.recruiter_period_start(now());
  v_period_end date;
  v_total numeric := 0;
  v_count integer := 0;
  v_recent jsonb := '[]'::jsonb;
  v_history jsonb := '[]'::jsonb;
  v_invites jsonb := '[]'::jsonb;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Unauthorized'; END IF;
  SELECT * INTO v_application
  FROM public.recruiter_applications WHERE user_id = auth.uid();

  IF NOT FOUND THEN
    RETURN jsonb_build_object('application', NULL, 'approved', false);
  END IF;

  v_period_end := (date_trunc('month', v_period_start + interval '1 month')::date + 26);

  IF v_application.status = 'approved' THEN
    SELECT COALESCE(sum(t.amount), 0), count(*)::integer
    INTO v_total, v_count
    FROM public.referrals r
    JOIN public.transactions t ON t.id = r.first_deposit_transaction_id
    JOIN public.deposit_tranches d ON d.transaction_id = t.id AND d.source = 'deposit'
    WHERE r.referrer_id = auth.uid()
      AND r.created_at >= v_application.approved_at
      AND t.status = 'completed' AND t.currency = 'ZAR' AND t.amount >= 1000
      AND d.growth_cycle_code = '30d'
      AND public.recruiter_period_start(d.created_at) = v_period_start;

    SELECT COALESCE(jsonb_agg(row_data ORDER BY approved_at DESC), '[]'::jsonb)
    INTO v_recent
    FROM (
      SELECT jsonb_build_object(
        'referralId', r.id,
        'accountId', p.account_id,
        'name', trim(concat_ws(' ', p.first_name, p.surname)),
        'joinedAt', r.created_at,
        'depositAmount', t.amount,
        'cycleLabel', d.cycle_label,
        'approvedAt', d.created_at,
        'qualifies', t.status = 'completed' AND t.currency = 'ZAR'
          AND t.amount >= 1000 AND d.growth_cycle_code = '30d'
          AND public.recruiter_period_start(d.created_at) = v_period_start
      ) AS row_data,
      COALESCE(d.created_at, r.created_at) AS approved_at
      FROM public.referrals r
      JOIN public.profiles p ON p.id = r.referred_user_id
      LEFT JOIN public.transactions t ON t.id = r.first_deposit_transaction_id
      LEFT JOIN public.deposit_tranches d ON d.transaction_id = t.id AND d.source = 'deposit'
      WHERE r.referrer_id = auth.uid() AND r.created_at >= v_application.approved_at
      ORDER BY COALESCE(d.created_at, r.created_at) DESC
      LIMIT 50
    ) recent;

    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'periodStart', s.period_start, 'periodEnd', s.period_end,
      'qualifyingRecruits', s.qualifying_recruits,
      'qualifyingDeposits', s.qualifying_deposits,
      'salaryAmount', s.salary_amount, 'status', s.status,
      'creditedAt', s.credited_at
    ) ORDER BY s.period_start DESC), '[]'::jsonb)
    INTO v_history
    FROM (
      SELECT * FROM public.recruiter_salary_periods
      WHERE recruiter_id = auth.uid() ORDER BY period_start DESC LIMIT 12
    ) s;

    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'id', i.id, 'name', trim(concat_ws(' ', i.invitee_first_name, i.invitee_surname)),
      'email', i.invitee_email, 'status', i.status, 'createdAt', i.created_at
    ) ORDER BY i.created_at DESC), '[]'::jsonb)
    INTO v_invites
    FROM (
      SELECT * FROM public.recruiter_invites
      WHERE recruiter_id = auth.uid() ORDER BY created_at DESC LIMIT 25
    ) i;
  END IF;

  RETURN jsonb_build_object(
    'application', jsonb_build_object(
      'id', v_application.id, 'status', v_application.status,
      'appliedAt', v_application.applied_at, 'approvedAt', v_application.approved_at,
      'reviewNote', v_application.review_note,
      'bankName', v_application.bank_name_snapshot,
      'bankAccountLast4', v_application.bank_account_last4,
      'agreementVersion', v_application.agreement_version
    ),
    'approved', v_application.status = 'approved',
    'period', jsonb_build_object(
      'start', v_period_start, 'end', v_period_end, 'salaryDate', v_period_end + 1,
      'target', 20000, 'qualifyingDeposits', v_total,
      'qualifyingRecruits', v_count, 'remaining', greatest(0, 20000 - v_total),
      'qualified', v_total >= 20000
    ),
    'recentReferrals', v_recent, 'salaryHistory', v_history, 'invites', v_invites
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_list_recruiter_applications()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_result jsonb;
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(), 'admin'::public.app_role) THEN
    RAISE EXCEPTION 'Forbidden';
  END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'id', a.id, 'userId', a.user_id, 'status', a.status,
      'appliedAt', a.applied_at, 'approvedAt', a.approved_at,
      'reviewNote', a.review_note, 'agreementVersion', a.agreement_version,
      'bankName', a.bank_name_snapshot, 'bankAccountLast4', a.bank_account_last4,
      'accountId', p.account_id, 'firstName', p.first_name, 'surname', p.surname,
      'email', p.email, 'phone', p.phone
    ) ORDER BY a.applied_at DESC), '[]'::jsonb)
  INTO v_result
  FROM public.recruiter_applications a
  JOIN public.profiles p ON p.id = a.user_id;
  RETURN v_result;
END;
$$;

-- Credit each qualifying recruiter once for the most recently closed period.
-- The unique period row and request-like transaction reference make the job
-- safe to retry after timeouts or overlapping cron invocations.
CREATE OR REPLACE FUNCTION public.credit_due_recruiter_salaries(p_at timestamptz DEFAULT now())
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_local_date date := (p_at AT TIME ZONE 'Africa/Johannesburg')::date;
  v_period_end date;
  v_period_start date;
  v_application record;
  v_total numeric;
  v_count integer;
  v_period_id uuid;
  v_tx_id uuid;
  v_paid integer := 0;
BEGIN
  IF extract(day FROM v_local_date) >= 28 THEN
    v_period_end := date_trunc('month', v_local_date)::date + 26;
  ELSE
    v_period_end := (date_trunc('month', v_local_date)::date - interval '1 month')::date + 26;
  END IF;
  v_period_start := least(
    (date_trunc('month', v_period_end)::date - interval '1 month')::date + 28,
    (date_trunc('month', v_period_end)::date - interval '1 day')::date
  );

  FOR v_application IN
    SELECT * FROM public.recruiter_applications
    WHERE status = 'approved'
      AND approved_at < (v_period_start::timestamp AT TIME ZONE 'Africa/Johannesburg')
    FOR UPDATE SKIP LOCKED
  LOOP
    BEGIN
      SELECT COALESCE(sum(t.amount), 0), count(*)::integer
      INTO v_total, v_count
      FROM public.referrals r
      JOIN public.transactions t ON t.id = r.first_deposit_transaction_id
      JOIN public.deposit_tranches d ON d.transaction_id = t.id AND d.source = 'deposit'
      WHERE r.referrer_id = v_application.user_id
        AND r.created_at >= v_application.approved_at
        AND t.status = 'completed' AND t.currency = 'ZAR' AND t.amount >= 1000
        AND d.growth_cycle_code = '30d'
        AND public.recruiter_period_start(d.created_at) = v_period_start;

      v_period_id := NULL;
      INSERT INTO public.recruiter_salary_periods (
        recruiter_id, period_start, period_end, qualifying_recruits,
        qualifying_deposits, target_amount, salary_amount, status
      ) VALUES (
        v_application.user_id, v_period_start, v_period_end, v_count,
        round(v_total, 2), 20000, CASE WHEN v_total >= 20000 THEN 3000 ELSE 0 END,
        CASE WHEN v_total >= 20000 THEN 'processing' ELSE 'not_qualified' END
      )
      ON CONFLICT (recruiter_id, period_start) DO NOTHING
      RETURNING id INTO v_period_id;

      IF v_period_id IS NULL OR v_total < 20000 THEN CONTINUE; END IF;

      UPDATE public.wallets SET balance = balance + 3000, updated_at = now()
      WHERE user_id = v_application.user_id AND currency = 'ZAR';
      IF NOT FOUND THEN RAISE EXCEPTION 'Recruiter ZAR wallet not found'; END IF;

      INSERT INTO public.transactions (
        user_id, type, currency, amount, status, description, reference
      ) VALUES (
        v_application.user_id, 'bonus', 'ZAR', 3000, 'completed',
        'Recruiter monthly salary - ' || v_period_start || ' to ' || v_period_end,
        'RECRUITER-SALARY-' || v_application.user_id::text || '-' || v_period_start::text
      ) RETURNING id INTO v_tx_id;

      INSERT INTO public.deposit_tranches (
        user_id, currency, amount, remaining, current_balance, status, source,
        transaction_id, maturity_date, approved, note
      ) VALUES (
        v_application.user_id, 'ZAR', 3000, 3000, 3000, 'matured',
        'recruiter_salary', v_tx_id, now(), true,
        'Immediately withdrawable recruiter salary for ' || v_period_start || ' to ' || v_period_end
      );

      UPDATE public.recruiter_salary_periods
      SET status = 'paid', transaction_id = v_tx_id, credited_at = now()
      WHERE id = v_period_id;
      v_paid := v_paid + 1;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'Skipped recruiter salary for %: %', v_application.user_id, SQLERRM;
    END;
  END LOOP;
  RETURN v_paid;
END;
$$;

REVOKE ALL ON FUNCTION public.recruiter_period_start(timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.submit_my_recruiter_application(text, boolean) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.admin_review_recruiter_application(uuid, text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_my_recruiter_dashboard() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.admin_list_recruiter_applications() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.credit_due_recruiter_salaries(timestamptz) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.submit_my_recruiter_application(text, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_review_recruiter_application(uuid, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_my_recruiter_dashboard() TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_list_recruiter_applications() TO authenticated;
GRANT EXECUTE ON FUNCTION public.credit_due_recruiter_salaries(timestamptz) TO service_role;

CREATE EXTENSION IF NOT EXISTS pg_cron;
DO $$
DECLARE v_job bigint;
BEGIN
  FOR v_job IN SELECT jobid FROM cron.job WHERE jobname = 'recruiter-salary-daily-safety-run'
  LOOP
    PERFORM cron.unschedule(v_job);
  END LOOP;
  -- Supabase cron is UTC. 00:15 UTC is 02:15 in Johannesburg; daily execution
  -- also catches up safely if the scheduled 28th run was temporarily missed.
  PERFORM cron.schedule(
    'recruiter-salary-daily-safety-run',
    '15 0 * * *',
    'SELECT public.credit_due_recruiter_salaries();'
  );
END;
$$;
