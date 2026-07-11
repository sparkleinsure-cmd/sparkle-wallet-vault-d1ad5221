
ALTER TABLE public.deposit_tranches
  ADD COLUMN IF NOT EXISTS current_balance NUMERIC NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'locked';

-- Backfill existing rows
UPDATE public.deposit_tranches
SET current_balance = amount
WHERE current_balance = 0 AND amount > 0;

UPDATE public.deposit_tranches
SET status = CASE WHEN maturity_date <= now() THEN 'matured' ELSE 'locked' END;

-- Function: apply 1% daily incentive + mature due tranches
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
  UPDATE public.deposit_tranches
  SET current_balance = current_balance + (amount * 0.01)
  WHERE status = 'locked'
    AND maturity_date > now();

  -- Mature tranches whose maturity date has passed
  FOR t IN
    SELECT * FROM public.deposit_tranches
    WHERE status = 'locked' AND maturity_date <= now()
  LOOP
    gain := COALESCE(t.current_balance, t.amount) - t.amount;
    IF gain > 0 THEN
      UPDATE public.wallets
        SET balance = balance + gain, updated_at = now()
        WHERE user_id = t.user_id AND currency = t.currency;

      INSERT INTO public.transactions (user_id, type, currency, amount, status, description)
      VALUES (t.user_id, 'bonus', t.currency, gain, 'completed',
              'Matured tranche incentive (30-day cycle)');
    END IF;

    UPDATE public.deposit_tranches
    SET status = 'matured'
    WHERE id = t.id;
  END LOOP;
END;
$$;

-- Schedule daily at 22:00 UTC = 00:00 SAST
CREATE EXTENSION IF NOT EXISTS pg_cron;

DO $$
BEGIN
  PERFORM cron.unschedule('daily-tranche-incentive');
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

SELECT cron.schedule(
  'daily-tranche-incentive',
  '0 22 * * *',
  $$SELECT public.apply_daily_tranche_incentive();$$
);
