-- Daily, auditable wallet-health history and a simple loyalty reward.
-- A point is earned at each completed 30-day streak with at least R2,000
-- withdrawable ZAR, and is immediately credited as a R9.99 wallet bonus.
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS reward_points integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS reward_streak_days integer NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS public.wallet_health_daily (
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  snapshot_date date NOT NULL,
  withdrawable_zar numeric(18,2) NOT NULL DEFAULT 0,
  wallet_health integer NOT NULL DEFAULT 0,
  daily_top_ups numeric(18,2) NOT NULL DEFAULT 0,
  withdrawals numeric(18,2) NOT NULL DEFAULT 0,
  penalties numeric(18,2) NOT NULL DEFAULT 0,
  reward_credit numeric(18,2) NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, snapshot_date)
);
GRANT SELECT ON public.wallet_health_daily TO authenticated;
GRANT ALL ON public.wallet_health_daily TO service_role;
ALTER TABLE public.wallet_health_daily ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own wallet health read" ON public.wallet_health_daily
  FOR SELECT TO authenticated USING (auth.uid() = user_id);

CREATE TABLE IF NOT EXISTS public.wallet_reward_credits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  qualifying_date date NOT NULL,
  points integer NOT NULL DEFAULT 1 CHECK (points > 0),
  value numeric(18,2) NOT NULL DEFAULT 9.99 CHECK (value > 0),
  transaction_id uuid REFERENCES public.transactions(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, qualifying_date)
);
GRANT SELECT ON public.wallet_reward_credits TO authenticated;
GRANT ALL ON public.wallet_reward_credits TO service_role;
ALTER TABLE public.wallet_reward_credits ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own reward credits read" ON public.wallet_reward_credits
  FOR SELECT TO authenticated USING (auth.uid() = user_id);

CREATE OR REPLACE FUNCTION public.apply_daily_tranche_incentive()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  t RECORD;
  p RECORD;
  daily NUMERIC;
  gain NUMERIC;
  v_snapshot_date date := (now() AT TIME ZONE 'Africa/Johannesburg')::date;
  v_withdrawable numeric;
  v_locked numeric;
  v_top_ups numeric;
  v_withdrawals numeric;
  v_penalties numeric;
  v_health integer;
  v_streak integer;
  v_tx_id uuid;
BEGIN
  FOR t IN
    SELECT * FROM public.deposit_tranches
    WHERE status = 'locked'
      AND approved = true
      AND maturity_date > now()
      AND remaining > 0
      AND current_balance > 0
  LOOP
    daily := ROUND((t.remaining * 0.01)::numeric, 2);
    IF daily <= 0 THEN CONTINUE; END IF;
    UPDATE public.deposit_tranches SET current_balance = current_balance + daily WHERE id = t.id;
    INSERT INTO public.transactions (user_id, type, currency, amount, status, description)
    VALUES (t.user_id, 'bonus', t.currency, daily, 'completed', 'Account top up (1% daily incentive)');
  END LOOP;

  FOR t IN
    SELECT * FROM public.deposit_tranches
    WHERE status = 'locked'
      AND approved = true
      AND maturity_date <= now()
      AND remaining > 0
      AND current_balance > 0
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

  -- One snapshot per SAST day makes the graph and reward calculation
  -- reproducible. If the scheduled job is retried, no extra point is issued.
  FOR p IN SELECT id FROM public.profiles LOOP
    SELECT COALESCE(balance, 0) INTO v_withdrawable
    FROM public.wallets WHERE user_id = p.id AND currency = 'ZAR';
    SELECT COALESCE(sum(remaining), 0) INTO v_locked
    FROM public.deposit_tranches
    WHERE user_id = p.id AND currency = 'ZAR' AND status = 'locked'
      AND approved = true AND maturity_date > now() AND remaining > 0;
    v_withdrawable := greatest(0, COALESCE(v_withdrawable, 0) - COALESCE(v_locked, 0));
    SELECT COALESCE(sum(amount), 0) INTO v_top_ups FROM public.transactions
      WHERE user_id = p.id AND currency = 'ZAR' AND type = 'bonus' AND status = 'completed'
        AND description LIKE 'Account top up%' AND (created_at AT TIME ZONE 'Africa/Johannesburg')::date = v_snapshot_date;
    SELECT COALESCE(sum(amount), 0) INTO v_withdrawals FROM public.transactions
      WHERE user_id = p.id AND currency = 'ZAR' AND type = 'withdrawal'
        AND (created_at AT TIME ZONE 'Africa/Johannesburg')::date = v_snapshot_date;
    SELECT COALESCE(sum(amount), 0) INTO v_penalties FROM public.transactions
      WHERE user_id = p.id AND currency = 'ZAR' AND type = 'fee'
        AND (created_at AT TIME ZONE 'Africa/Johannesburg')::date = v_snapshot_date;
    v_health := least(100, greatest(0, round((v_withdrawable / 2000) * 100)::integer));

    INSERT INTO public.wallet_health_daily (
      user_id, snapshot_date, withdrawable_zar, wallet_health, daily_top_ups, withdrawals, penalties
    ) VALUES (p.id, v_snapshot_date, v_withdrawable, v_health, v_top_ups, v_withdrawals, v_penalties)
    ON CONFLICT (user_id, snapshot_date) DO NOTHING;

    IF FOUND THEN
      UPDATE public.profiles
      SET reward_streak_days = CASE WHEN v_withdrawable >= 2000 THEN reward_streak_days + 1 ELSE 0 END
      WHERE id = p.id
      RETURNING reward_streak_days INTO v_streak;

      IF v_withdrawable >= 2000 AND v_streak > 0 AND mod(v_streak, 30) = 0 THEN
        INSERT INTO public.transactions (user_id, type, currency, amount, status, description)
        VALUES (p.id, 'bonus', 'ZAR', 9.99, 'completed', 'Wallet health reward — 1 point (30-day R2,000 hold)')
        RETURNING id INTO v_tx_id;
        INSERT INTO public.wallet_reward_credits (user_id, qualifying_date, points, value, transaction_id)
        VALUES (p.id, v_snapshot_date, 1, 9.99, v_tx_id)
        ON CONFLICT (user_id, qualifying_date) DO NOTHING;
        IF FOUND THEN
          UPDATE public.wallets SET balance = balance + 9.99, updated_at = now()
          WHERE user_id = p.id AND currency = 'ZAR';
          UPDATE public.profiles SET reward_points = reward_points + 1 WHERE id = p.id;
          UPDATE public.wallet_health_daily SET reward_credit = 9.99
          WHERE user_id = p.id AND snapshot_date = v_snapshot_date;
        END IF;
      END IF;
    END IF;
  END LOOP;
END;
$$;
