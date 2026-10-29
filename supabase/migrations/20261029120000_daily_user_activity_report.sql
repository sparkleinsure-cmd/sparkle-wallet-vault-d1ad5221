-- Append-only activity: do not retain passwords, tokens, document URLs or bank values.
CREATE TABLE public.user_daily_activity (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('login', 'settings')),
  changed_fields text[] NOT NULL DEFAULT '{}',
  actor_id uuid,
  occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX user_daily_activity_time_idx ON public.user_daily_activity (occurred_at);
ALTER TABLE public.user_daily_activity ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.user_daily_activity FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON public.user_daily_activity TO service_role;

CREATE FUNCTION public.capture_daily_user_activity()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  fields text[];
BEGIN
  IF TG_TABLE_SCHEMA = 'auth' THEN
    IF NEW.last_sign_in_at IS DISTINCT FROM OLD.last_sign_in_at AND NEW.last_sign_in_at IS NOT NULL THEN
      INSERT INTO public.user_daily_activity (user_id, kind, occurred_at)
      VALUES (NEW.id, 'login', NEW.last_sign_in_at);
    END IF;
    SELECT coalesce(array_agg(k), '{}') INTO fields
    FROM unnest(ARRAY['email','phone','encrypted_password']) k
    WHERE to_jsonb(NEW)->k IS DISTINCT FROM to_jsonb(OLD)->k;
    fields := array_replace(fields, 'encrypted_password', 'password');
  ELSE
    SELECT coalesce(array_agg(k), '{}') INTO fields
    FROM unnest(ARRAY['first_name','surname','phone','primary_currency','street_address',
      'province','postal_code','bank_name','bank_account_number','bank_details_change_requested_at',
      'selfie_url','proof_url']) k
    WHERE to_jsonb(NEW)->k IS DISTINCT FROM to_jsonb(OLD)->k;
  END IF;
  IF cardinality(fields) > 0 THEN
    INSERT INTO public.user_daily_activity (user_id, kind, changed_fields, actor_id)
    VALUES (NEW.id, 'settings', fields, auth.uid());
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.capture_daily_user_activity() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER capture_daily_profile_activity AFTER UPDATE ON public.profiles
FOR EACH ROW EXECUTE FUNCTION public.capture_daily_user_activity();
CREATE TRIGGER capture_daily_auth_activity AFTER UPDATE ON auth.users
FOR EACH ROW EXECUTE FUNCTION public.capture_daily_user_activity();

-- Only the latest historical sign-in is available before activity logging starts.
INSERT INTO public.user_daily_activity (user_id, kind, occurred_at)
SELECT id, 'login', last_sign_in_at FROM auth.users WHERE last_sign_in_at IS NOT NULL;

-- Midnight uses the previous SAST day. An explicit resend uses today so far.
CREATE FUNCTION public.collect_admin_daily_activity(p_today boolean DEFAULT false)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_report_date date := (now() AT TIME ZONE 'Africa/Johannesburg')::date - CASE WHEN p_today THEN 0 ELSE 1 END;
  v_start_time timestamptz := v_report_date::timestamp AT TIME ZONE 'Africa/Johannesburg';
  v_end_time timestamptz := CASE WHEN p_today THEN now() ELSE (v_report_date + 1)::timestamp AT TIME ZONE 'Africa/Johannesburg' END;
  v_data jsonb;
BEGIN
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
    'activeLoggedInCount', (SELECT count(DISTINCT user_id) FROM public.user_daily_activity WHERE kind = 'login' AND occurred_at >= v_start_time AND occurred_at < v_end_time),
    'activeLoggedInUsers', (
      SELECT coalesce(jsonb_agg(x ORDER BY x."lastSeenAt" DESC), '[]'::jsonb) FROM (
        SELECT a.user_id AS "userId", p.account_id AS "accountId", concat_ws(' ', p.first_name, p.surname) AS name,
          p.email, max(a.occurred_at) AS "lastSeenAt", count(*) AS "loginCount"
        FROM public.user_daily_activity a LEFT JOIN public.profiles p ON p.id = a.user_id
        WHERE a.kind = 'login' AND a.occurred_at >= v_start_time AND a.occurred_at < v_end_time
        GROUP BY a.user_id, p.account_id, p.first_name, p.surname, p.email
      ) x
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

  RETURN v_data || jsonb_build_object(
    'transactionsList', (
      SELECT coalesce(jsonb_agg(x ORDER BY x."createdAt" DESC), '[]'::jsonb) FROM (
        SELECT t.id, t.user_id AS "userId", p.account_id AS "accountId",
          concat_ws(' ', p.first_name, p.surname) AS name, t.type, t.amount, t.currency,
          t.status, t.reference, t.description, t.created_at AS "createdAt"
        FROM public.transactions t LEFT JOIN public.profiles p ON p.id = t.user_id
        WHERE t.created_at >= v_start_time AND t.created_at < v_end_time
      ) x
    ),
    'transfersList', (
      SELECT coalesce(jsonb_agg(x ORDER BY x."createdAt" DESC), '[]'::jsonb) FROM (
        SELECT t.id, coalesce(s.account_id, t.sender_id::text) AS "senderAccountId",
          concat_ws(' ', s.first_name, s.surname) AS "senderName",
          coalesce(r.account_id, t.recipient_id::text) AS "recipientAccountId",
          concat_ws(' ', r.first_name, r.surname) AS "recipientName",
          t.amount, t.currency, t.status, t.created_at AS "createdAt", t.completed_at AS "completedAt",
          t.reviewed_at AS "reviewedAt"
        FROM public.member_wallet_transfers t
        LEFT JOIN public.profiles s ON s.id = t.sender_id
        LEFT JOIN public.profiles r ON r.id = t.recipient_id
        WHERE (t.created_at >= v_start_time AND t.created_at < v_end_time)
          OR (t.completed_at >= v_start_time AND t.completed_at < v_end_time)
          OR (t.reviewed_at >= v_start_time AND t.reviewed_at < v_end_time)
      ) x
    ),
    'settingsList', (
      SELECT coalesce(jsonb_agg(x ORDER BY x."occurredAt" DESC), '[]'::jsonb) FROM (
        SELECT a.user_id AS "userId", p.account_id AS "accountId",
          concat_ws(' ', p.first_name, p.surname) AS name,
          a.changed_fields AS "changedFields", a.occurred_at AS "occurredAt",
          CASE WHEN a.actor_id = a.user_id THEN 'user'
            WHEN a.actor_id IS NULL THEN 'authentication or server'
            ELSE 'administrator' END AS actor
        FROM public.user_daily_activity a LEFT JOIN public.profiles p ON p.id = a.user_id
        WHERE a.kind = 'settings' AND a.occurred_at >= v_start_time AND a.occurred_at < v_end_time
      ) x
    )
  );
END;
$$;
REVOKE ALL ON FUNCTION public.collect_admin_daily_activity(boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.collect_admin_daily_activity(boolean) TO service_role;
