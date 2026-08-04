-- A deleted auth user can leave a legacy tranche behind. Do not let such a
-- record abort the shared daily job for every valid member cycle.
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
      AND EXISTS (SELECT 1 FROM auth.users u WHERE u.id = deposit_tranches.user_id)
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
      AND EXISTS (SELECT 1 FROM auth.users u WHERE u.id = deposit_tranches.user_id)
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
