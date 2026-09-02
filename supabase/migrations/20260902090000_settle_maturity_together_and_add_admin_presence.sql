-- Keep a due cycle locked until its principal and full accrued incentive can
-- move to withdrawable together. The settlement is idempotent and commits as
-- one database transaction for each account refresh or scheduled run.
CREATE OR REPLACE FUNCTION public.settle_due_tranches_for_user(p_user_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tranche public.deposit_tranches%ROWTYPE;
  v_gain numeric;
  v_settled integer := 0;
BEGIN
  FOR v_tranche IN
    SELECT *
    FROM public.deposit_tranches
    WHERE user_id = p_user_id
      AND status = 'locked'
      AND approved = true
      AND maturity_date <= now()
      AND remaining > 0
      AND current_balance > 0
    ORDER BY maturity_date, created_at
    FOR UPDATE
  LOOP
    BEGIN
      v_gain := greatest(0, COALESCE(v_tranche.current_balance, v_tranche.remaining) - v_tranche.remaining);

      INSERT INTO public.tranche_maturity_settlements (tranche_id, gain)
      VALUES (v_tranche.id, v_gain)
      ON CONFLICT DO NOTHING;

      IF NOT FOUND THEN
        CONTINUE;
      END IF;

      IF v_gain > 0 THEN
        UPDATE public.wallets
        SET balance = balance + v_gain,
            updated_at = now()
        WHERE user_id = p_user_id
          AND currency = v_tranche.currency;

        IF NOT FOUND THEN
          RAISE EXCEPTION 'Maturity wallet is missing for tranche %', v_tranche.id;
        END IF;

        INSERT INTO public.transactions (
          user_id, type, currency, amount, status, description, reference
        ) VALUES (
          p_user_id, 'bonus', v_tranche.currency, v_gain, 'completed',
          'Matured tranche incentive (30-day cycle)',
          'MATURITY-' || v_tranche.id::text
        );
      END IF;

      UPDATE public.deposit_tranches
      SET status = 'matured',
          current_balance = remaining
      WHERE id = v_tranche.id;

      v_settled := v_settled + 1;
    EXCEPTION WHEN OTHERS THEN
      -- Preserve access for the member and leave the complete cycle locked if
      -- a malformed legacy row cannot be settled safely.
      RAISE WARNING 'Skipped maturity for tranche %: %', v_tranche.id, SQLERRM;
    END;
  END LOOP;

  RETURN v_settled;
END;
$$;

REVOKE ALL ON FUNCTION public.settle_due_tranches_for_user(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.settle_due_tranches_for_user(uuid) TO service_role;

-- Presence is deliberately separate from profiles and has no member-readable
-- policy. Members can update their own heartbeat only through the app API;
-- admin-only endpoints expose the aggregate and per-user last-seen values.
CREATE TABLE IF NOT EXISTS public.user_presence (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  last_seen_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS user_presence_last_seen_at_idx
  ON public.user_presence (last_seen_at DESC);

ALTER TABLE public.user_presence ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.user_presence FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.user_presence TO service_role;

-- A tranche remains unavailable while its status is locked, including the
-- brief period after its due timestamp and before settlement completes.
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
  WHERE user_id = p_user_id
    AND currency = 'ZAR'
    AND status = 'locked'
    AND approved = true
    AND remaining > 0;

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
    user_id, snapshot_date, withdrawable_zar, wallet_health, daily_top_ups, withdrawals, penalties
  ) VALUES (
    p_user_id, v_snapshot_date, v_withdrawable, v_health, v_top_ups, v_withdrawals, v_penalties
  )
  ON CONFLICT (user_id, snapshot_date) DO UPDATE SET
    withdrawable_zar = EXCLUDED.withdrawable_zar,
    wallet_health = EXCLUDED.wallet_health,
    daily_top_ups = EXCLUDED.daily_top_ups,
    withdrawals = EXCLUDED.withdrawals,
    penalties = EXCLUDED.penalties;
END;
$$;

REVOKE ALL ON FUNCTION public.record_wallet_health_snapshot(uuid) FROM PUBLIC, anon, authenticated;
