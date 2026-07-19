-- Keep the wallet-health visual current as money moves, without turning a
-- same-day refresh into extra reward days. Rewards are still evaluated once
-- per SAST calendar day by the existing scheduled incentive job.

CREATE TABLE IF NOT EXISTS public.wallet_health_reward_days (
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  snapshot_date date NOT NULL,
  PRIMARY KEY (user_id, snapshot_date)
);
GRANT ALL ON public.wallet_health_reward_days TO service_role;
ALTER TABLE public.wallet_health_reward_days ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.record_wallet_health_snapshot(p_user_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_snapshot_date date := (now() AT TIME ZONE 'Africa/Johannesburg')::date;
  v_withdrawable numeric;
  v_locked numeric;
  v_top_ups numeric;
  v_withdrawals numeric;
  v_penalties numeric;
  v_health integer;
BEGIN
  SELECT COALESCE(balance, 0) INTO v_withdrawable
  FROM public.wallets WHERE user_id = p_user_id AND currency = 'ZAR';

  SELECT COALESCE(sum(remaining), 0) INTO v_locked
  FROM public.deposit_tranches
  WHERE user_id = p_user_id AND currency = 'ZAR' AND status = 'locked'
    AND approved = true AND maturity_date > now() AND remaining > 0;

  v_withdrawable := greatest(0, COALESCE(v_withdrawable, 0) - COALESCE(v_locked, 0));

  -- Positive verified account activity: verified deposits and bonuses. The
  -- health reward itself is shown separately, not counted as a top-up.
  SELECT COALESCE(sum(amount), 0) INTO v_top_ups
  FROM public.transactions
  WHERE user_id = p_user_id AND currency = 'ZAR' AND status = 'completed'
    AND type IN ('deposit', 'bonus')
    AND description NOT LIKE 'Wallet health reward%'
    AND (created_at AT TIME ZONE 'Africa/Johannesburg')::date = v_snapshot_date;

  SELECT COALESCE(sum(amount), 0) INTO v_withdrawals
  FROM public.transactions
  WHERE user_id = p_user_id AND currency = 'ZAR' AND type = 'withdrawal'
    AND status <> 'failed'
    AND (created_at AT TIME ZONE 'Africa/Johannesburg')::date = v_snapshot_date;

  SELECT COALESCE(sum(amount), 0) INTO v_penalties
  FROM public.transactions
  WHERE user_id = p_user_id AND currency = 'ZAR' AND type = 'fee' AND status = 'completed'
    AND (created_at AT TIME ZONE 'Africa/Johannesburg')::date = v_snapshot_date;

  v_health := least(100, greatest(0, round((v_withdrawable / 2000) * 100)::integer));

  INSERT INTO public.wallet_health_daily (
    user_id, snapshot_date, withdrawable_zar, wallet_health, daily_top_ups, withdrawals, penalties
  ) VALUES (p_user_id, v_snapshot_date, v_withdrawable, v_health, v_top_ups, v_withdrawals, v_penalties)
  ON CONFLICT (user_id, snapshot_date) DO UPDATE SET
    withdrawable_zar = EXCLUDED.withdrawable_zar,
    wallet_health = EXCLUDED.wallet_health,
    daily_top_ups = EXCLUDED.daily_top_ups,
    withdrawals = EXCLUDED.withdrawals,
    penalties = EXCLUDED.penalties;
END;
$$;

CREATE OR REPLACE FUNCTION public.refresh_wallet_health_from_activity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id uuid;
  v_currency text;
  v_status public.tx_status;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_user_id := OLD.user_id;
    v_currency := OLD.currency;
    v_status := CASE WHEN TG_TABLE_NAME = 'transactions' THEN OLD.status ELSE NULL END;
  ELSE
    v_user_id := NEW.user_id;
    v_currency := NEW.currency;
    v_status := CASE WHEN TG_TABLE_NAME = 'transactions' THEN NEW.status ELSE NULL END;
  END IF;

  IF v_currency = 'ZAR' AND (
    TG_TABLE_NAME = 'wallets' OR TG_OP <> 'INSERT' OR v_status = 'completed'
  ) THEN
    PERFORM public.record_wallet_health_snapshot(v_user_id);
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS wallet_health_on_wallet_change ON public.wallets;
CREATE CONSTRAINT TRIGGER wallet_health_on_wallet_change
AFTER INSERT OR UPDATE OF balance OR DELETE ON public.wallets
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION public.refresh_wallet_health_from_activity();

DROP TRIGGER IF EXISTS wallet_health_on_transaction_change ON public.transactions;
CREATE CONSTRAINT TRIGGER wallet_health_on_transaction_change
AFTER INSERT OR UPDATE OF status, amount, currency, description OR DELETE ON public.transactions
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION public.refresh_wallet_health_from_activity();

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
  v_snapshot_date date := (now() AT TIME ZONE 'Africa/Johannesburg')::date;
  v_withdrawable numeric;
  v_streak integer;
  v_checked_user uuid;
  v_tx_id uuid;
BEGIN
  FOR t IN
    SELECT * FROM public.deposit_tranches
    WHERE status = 'locked' AND approved = true AND maturity_date > now()
      AND remaining > 0 AND current_balance > 0
  LOOP
    daily := ROUND((t.remaining * 0.01)::numeric, 2);
    IF daily <= 0 THEN CONTINUE; END IF;
    UPDATE public.deposit_tranches SET current_balance = current_balance + daily WHERE id = t.id;
    INSERT INTO public.transactions (user_id, type, currency, amount, status, description)
    VALUES (t.user_id, 'bonus', t.currency, daily, 'completed', 'Account top up (1% daily incentive)');
  END LOOP;

  FOR t IN
    SELECT * FROM public.deposit_tranches
    WHERE status = 'locked' AND approved = true AND maturity_date <= now()
      AND remaining > 0 AND current_balance > 0
  LOOP
    gain := COALESCE(t.current_balance, t.remaining) - t.remaining;
    IF gain > 0 THEN
      UPDATE public.wallets SET balance = balance + gain, updated_at = now()
      WHERE user_id = t.user_id AND currency = t.currency;
      INSERT INTO public.transactions (user_id, type, currency, amount, status, description)
      VALUES (t.user_id, 'bonus', t.currency, gain, 'completed', 'Matured tranche incentive (30-day cycle)');
    END IF;
    UPDATE public.deposit_tranches SET status = 'matured', current_balance = remaining WHERE id = t.id;
  END LOOP;

  FOR p IN SELECT id FROM public.profiles LOOP
    PERFORM public.record_wallet_health_snapshot(p.id);
    SELECT withdrawable_zar INTO v_withdrawable
    FROM public.wallet_health_daily WHERE user_id = p.id AND snapshot_date = v_snapshot_date;

    -- This insert makes repeated or delayed cron runs harmless: only the
    -- first daily check can advance the reward period.
    INSERT INTO public.wallet_health_reward_days (user_id, snapshot_date)
    VALUES (p.id, v_snapshot_date)
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
        VALUES (p.id, v_snapshot_date, 1, 9.99, v_tx_id)
        ON CONFLICT (user_id, qualifying_date) DO NOTHING;
        IF FOUND THEN
          UPDATE public.wallets SET balance = balance + 9.99, updated_at = now()
          WHERE user_id = p.id AND currency = 'ZAR';
          UPDATE public.profiles
          SET reward_points = reward_points + 1, reward_streak_days = 0
          WHERE id = p.id;
          UPDATE public.wallet_health_daily SET reward_credit = reward_credit + 9.99
          WHERE user_id = p.id AND snapshot_date = v_snapshot_date;
        END IF;
      END IF;
    ELSE
      UPDATE public.profiles SET reward_streak_days = 0 WHERE id = p.id;
    END IF;
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION public.record_wallet_health_snapshot(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.refresh_wallet_health_from_activity() FROM PUBLIC, anon, authenticated;
