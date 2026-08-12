-- Each tranche can receive at most one daily incentive for a Johannesburg
-- calendar date. This is enforced in the database so a duplicate cron run,
-- manual retry, or concurrent invocation cannot credit growth twice.
CREATE TABLE IF NOT EXISTS public.tranche_daily_incentives (
  tranche_id uuid NOT NULL REFERENCES public.deposit_tranches(id) ON DELETE CASCADE,
  incentive_date date NOT NULL,
  amount numeric(18,2) NOT NULL CHECK (amount > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tranche_id, incentive_date)
);

ALTER TABLE public.tranche_daily_incentives ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.tranche_daily_incentives FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.tranche_daily_incentives TO service_role;

CREATE OR REPLACE FUNCTION public.apply_daily_tranche_incentive()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  t RECORD;
  p RECORD;
  daily numeric;
  gain numeric;
  v_incentive_date date := (now() AT TIME ZONE 'Africa/Johannesburg')::date;
  v_withdrawable numeric;
  v_streak integer;
  v_checked_user uuid;
  v_tx_id uuid;
BEGIN
  -- Lock each qualifying cycle while its dated ledger row is claimed. SKIP
  -- LOCKED lets a concurrent retry safely skip work already in progress.
  FOR t IN
    SELECT * FROM public.deposit_tranches
    WHERE status = 'locked' AND approved = true AND maturity_date > now()
      AND remaining > 0 AND current_balance > 0
      AND EXISTS (SELECT 1 FROM auth.users u WHERE u.id = deposit_tranches.user_id)
    FOR UPDATE SKIP LOCKED
  LOOP
    daily := round((t.remaining * 0.01)::numeric, 2);
    IF daily <= 0 THEN CONTINUE; END IF;

    INSERT INTO public.tranche_daily_incentives (tranche_id, incentive_date, amount)
    VALUES (t.id, v_incentive_date, daily)
    ON CONFLICT (tranche_id, incentive_date) DO NOTHING;

    -- Only the invocation that successfully claimed this cycle/date can add
    -- the growth and its corresponding transaction ledger entry.
    IF NOT FOUND THEN CONTINUE; END IF;

    UPDATE public.deposit_tranches
    SET current_balance = current_balance + daily
    WHERE id = t.id;
    INSERT INTO public.transactions (user_id, type, currency, amount, status, description, reference)
    VALUES (
      t.user_id, 'bonus', t.currency, daily, 'completed',
      'Account top up (1% daily incentive)',
      'TRANCHE-' || t.id::text || '-' || to_char(v_incentive_date, 'YYYYMMDD')
    );
  END LOOP;

  -- A mature cycle is processed once: after this update it no longer matches
  -- the locked status predicate. Row locks also prevent duplicate maturity
  -- credits when the job is retried concurrently.
  FOR t IN
    SELECT * FROM public.deposit_tranches
    WHERE status = 'locked' AND approved = true AND maturity_date <= now()
      AND remaining > 0 AND current_balance > 0
      AND EXISTS (SELECT 1 FROM auth.users u WHERE u.id = deposit_tranches.user_id)
    FOR UPDATE SKIP LOCKED
  LOOP
    gain := COALESCE(t.current_balance, t.remaining) - t.remaining;
    IF gain > 0 THEN
      UPDATE public.wallets SET balance = balance + gain, updated_at = now()
      WHERE user_id = t.user_id AND currency = t.currency;
      INSERT INTO public.transactions (user_id, type, currency, amount, status, description)
      VALUES (t.user_id, 'bonus', t.currency, gain, 'completed', 'Matured tranche incentive (30-day cycle)');
    END IF;
    UPDATE public.deposit_tranches
    SET status = 'matured', current_balance = remaining
    WHERE id = t.id;
  END LOOP;

  FOR p IN SELECT id FROM public.profiles LOOP
    PERFORM public.record_wallet_health_snapshot(p.id);
    SELECT withdrawable_zar INTO v_withdrawable
    FROM public.wallet_health_daily WHERE user_id = p.id AND snapshot_date = v_incentive_date;

    INSERT INTO public.wallet_health_reward_days (user_id, snapshot_date)
    VALUES (p.id, v_incentive_date)
    ON CONFLICT DO NOTHING
    RETURNING user_id INTO v_checked_user;
    IF v_checked_user IS NULL THEN CONTINUE; END IF;

    IF v_withdrawable >= 2000 THEN
      UPDATE public.profiles SET reward_streak_days = reward_streak_days + 1
      WHERE id = p.id RETURNING reward_streak_days INTO v_streak;
      IF v_streak >= 30 THEN
        INSERT INTO public.transactions (user_id, type, currency, amount, status, description)
        VALUES (p.id, 'bonus', 'ZAR', 9.99, 'completed', 'Wallet health reward - 1 point (30-day R2,000 hold)')
        RETURNING id INTO v_tx_id;
        INSERT INTO public.wallet_reward_credits (user_id, qualifying_date, points, value, transaction_id)
        VALUES (p.id, v_incentive_date, 1, 9.99, v_tx_id)
        ON CONFLICT (user_id, qualifying_date) DO NOTHING;
        IF FOUND THEN
          UPDATE public.wallets SET balance = balance + 9.99, updated_at = now()
          WHERE user_id = p.id AND currency = 'ZAR';
          UPDATE public.profiles SET reward_points = reward_points + 1, reward_streak_days = 0
          WHERE id = p.id;
          UPDATE public.wallet_health_daily SET reward_credit = reward_credit + 9.99
          WHERE user_id = p.id AND snapshot_date = v_incentive_date;
        END IF;
      END IF;
    ELSE
      UPDATE public.profiles SET reward_streak_days = 0 WHERE id = p.id;
    END IF;
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION public.apply_daily_tranche_incentive() FROM PUBLIC, anon, authenticated;
