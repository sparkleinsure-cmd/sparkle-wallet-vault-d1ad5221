
-- Update the daily incentive function to use 'remaining' (principal) instead of 'amount' (initial deposit)
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
  -- 1% daily incentive on still-locked, not-yet-matured tranches
  -- Use 'remaining' (the current principal) instead of 'amount' (the initial deposit)
  UPDATE public.deposit_tranches
  SET current_balance = current_balance + (remaining * 0.01)
  WHERE status = 'locked'
    AND maturity_date > now()
    AND remaining > 0;

  -- Mature tranches whose maturity date has passed
  FOR t IN
    SELECT * FROM public.deposit_tranches
    WHERE status = 'locked' AND maturity_date <= now()
  LOOP
    -- The gain is what we added via current_balance increments
    gain := COALESCE(t.current_balance, t.remaining) - t.remaining;
    IF gain > 0 THEN
      UPDATE public.wallets
        SET balance = balance + gain, updated_at = now()
        WHERE user_id = t.user_id AND currency = t.currency;

      INSERT INTO public.transactions (user_id, type, currency, amount, status, description)
      VALUES (t.user_id, 'bonus', t.currency, gain, 'completed',
              'Matured tranche incentive (30-day cycle)');
    END IF;

    -- Update tranche to matured and sync current_balance to remaining
    UPDATE public.deposit_tranches
    SET status = 'matured',
        current_balance = remaining
    WHERE id = t.id;
  END LOOP;
END;
$$;
