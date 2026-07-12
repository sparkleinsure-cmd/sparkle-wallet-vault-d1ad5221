
-- Approval flag on tranches; new deposits will be inserted with approved=false, bonuses default true
ALTER TABLE public.deposit_tranches
  ADD COLUMN IF NOT EXISTS approved boolean NOT NULL DEFAULT true;

-- Rewrite daily incentive: only approved & locked tranches; log a daily "Account top up" transaction per tranche
CREATE OR REPLACE FUNCTION public.apply_daily_tranche_incentive()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  t RECORD;
  gain NUMERIC;
  daily NUMERIC;
BEGIN
  -- Daily 1% top-up on approved, locked, not-yet-matured tranches
  FOR t IN
    SELECT * FROM public.deposit_tranches
    WHERE status = 'locked'
      AND approved = true
      AND maturity_date > now()
  LOOP
    daily := ROUND((t.amount * 0.01)::numeric, 2);
    UPDATE public.deposit_tranches
      SET current_balance = COALESCE(current_balance, amount) + daily
      WHERE id = t.id;

    INSERT INTO public.transactions (user_id, type, currency, amount, status, description)
    VALUES (t.user_id, 'bonus', t.currency, daily, 'pending', 'Account top up');
  END LOOP;

  -- Mature tranches whose maturity date has passed (approved ones only)
  FOR t IN
    SELECT * FROM public.deposit_tranches
    WHERE status = 'locked' AND approved = true AND maturity_date <= now()
  LOOP
    gain := COALESCE(t.current_balance, t.amount) - t.amount;
    IF gain > 0 THEN
      UPDATE public.wallets
        SET balance = balance + gain, updated_at = now()
        WHERE user_id = t.user_id AND currency = t.currency;

      INSERT INTO public.transactions (user_id, type, currency, amount, status, description)
      VALUES (t.user_id, 'bonus', t.currency, gain, 'completed', 'Account top up (matured)');
    END IF;

    UPDATE public.deposit_tranches
    SET status = 'matured'
    WHERE id = t.id;
  END LOOP;
END;
$function$;
