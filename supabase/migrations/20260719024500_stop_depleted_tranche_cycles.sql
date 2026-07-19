-- A tranche that reaches zero through a withdrawal is permanently closed.
-- This prevents it from being selected by the scheduled incentive job again.
UPDATE public.deposit_tranches
SET
  remaining = 0,
  current_balance = 0,
  status = 'liquidated'
WHERE status = 'locked'
  AND (
    COALESCE(remaining, 0) <= 0
    OR COALESCE(current_balance, remaining, 0) <= 0
  );

-- The cron job is shared by every tranche, so there is no per-tranche cron
-- record to cancel. Its selection must instead exclude depleted/closed rows.
CREATE OR REPLACE FUNCTION public.apply_daily_tranche_incentive()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  t RECORD;
  gain NUMERIC;
BEGIN
  -- Defensive cleanup for rows depleted by legacy application code.
  UPDATE public.deposit_tranches
  SET
    remaining = 0,
    current_balance = 0,
    status = 'liquidated'
  WHERE status = 'locked'
    AND (
      COALESCE(remaining, 0) <= 0
      OR COALESCE(current_balance, remaining, 0) <= 0
    );

  -- Only approved, funded, still-locked tranches can grow.
  UPDATE public.deposit_tranches
  SET current_balance = current_balance + ROUND((remaining * 0.01)::numeric, 2)
  WHERE status = 'locked'
    AND approved = true
    AND maturity_date > now()
    AND remaining > 0
    AND current_balance > 0;

  -- Mature only funded tranches. Liquidated rows are intentionally excluded.
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
      UPDATE public.wallets
      SET balance = balance + gain, updated_at = now()
      WHERE user_id = t.user_id AND currency = t.currency;

      INSERT INTO public.transactions (user_id, type, currency, amount, status, description)
      VALUES (
        t.user_id,
        'bonus',
        t.currency,
        gain,
        'completed',
        'Matured tranche incentive (30-day cycle)'
      );
    END IF;

    UPDATE public.deposit_tranches
    SET status = 'matured', current_balance = remaining
    WHERE id = t.id;
  END LOOP;
END;
$$;
