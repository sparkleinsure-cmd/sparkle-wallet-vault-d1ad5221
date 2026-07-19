-- Keep the 1% daily growth job auditable in statements. The existing cron
-- schedule invokes this function at 22:00 UTC, which is midnight in SAST.
CREATE OR REPLACE FUNCTION public.apply_daily_tranche_incentive()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  t RECORD;
  daily NUMERIC;
  gain NUMERIC;
BEGIN
  -- Grow only funded, approved cycles that are still active. Each daily
  -- ledger entry is completed because it is an automatically applied top-up.
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

    UPDATE public.deposit_tranches
    SET current_balance = current_balance + daily
    WHERE id = t.id;

    INSERT INTO public.transactions (user_id, type, currency, amount, status, description)
    VALUES (t.user_id, 'bonus', t.currency, daily, 'completed', 'Account top up (1% daily incentive)');
  END LOOP;

  -- At maturity, release the accumulated growth to the wallet once.
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
      VALUES (t.user_id, 'bonus', t.currency, gain, 'completed', 'Matured tranche incentive (30-day cycle)');
    END IF;

    UPDATE public.deposit_tranches
    SET status = 'matured', current_balance = remaining
    WHERE id = t.id;
  END LOOP;
END;
$$;
