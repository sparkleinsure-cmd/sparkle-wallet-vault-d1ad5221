-- The chart represents the customer's full account movement, including funds
-- in an active growing tranche. Reward eligibility remains withdrawable-only.
ALTER TABLE public.wallet_health_daily
  ADD COLUMN IF NOT EXISTS wallet_value_zar numeric(18,2) NOT NULL DEFAULT 0;

CREATE OR REPLACE FUNCTION public.record_wallet_health_snapshot(p_user_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_snapshot_date date := (now() AT TIME ZONE 'Africa/Johannesburg')::date;
  v_wallet_value numeric;
  v_withdrawable numeric;
  v_locked numeric;
  v_top_ups numeric;
  v_withdrawals numeric;
  v_penalties numeric;
  v_health integer;
BEGIN
  SELECT COALESCE(balance, 0) INTO v_wallet_value
  FROM public.wallets WHERE user_id = p_user_id AND currency = 'ZAR';
  v_withdrawable := v_wallet_value;

  SELECT COALESCE(sum(remaining), 0) INTO v_locked
  FROM public.deposit_tranches
  WHERE user_id = p_user_id AND currency = 'ZAR' AND status = 'locked'
    AND approved = true AND maturity_date > now() AND remaining > 0;

  v_withdrawable := greatest(0, COALESCE(v_withdrawable, 0) - COALESCE(v_locked, 0));

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
    user_id, snapshot_date, wallet_value_zar, withdrawable_zar, wallet_health, daily_top_ups, withdrawals, penalties
  ) VALUES (p_user_id, v_snapshot_date, v_wallet_value, v_withdrawable, v_health, v_top_ups, v_withdrawals, v_penalties)
  ON CONFLICT (user_id, snapshot_date) DO UPDATE SET
    wallet_value_zar = EXCLUDED.wallet_value_zar,
    withdrawable_zar = EXCLUDED.withdrawable_zar,
    wallet_health = EXCLUDED.wallet_health,
    daily_top_ups = EXCLUDED.daily_top_ups,
    withdrawals = EXCLUDED.withdrawals,
    penalties = EXCLUDED.penalties;
END;
$$;

DO $$
DECLARE
  p record;
BEGIN
  FOR p IN SELECT id FROM public.profiles LOOP
    PERFORM public.record_wallet_health_snapshot(p.id);
  END LOOP;
END;
$$;
