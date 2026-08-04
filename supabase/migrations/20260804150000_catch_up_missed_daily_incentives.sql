-- One-time reconciliation for the four failed midnight SAST runs from
-- 1 through 4 August 2026. Only valid, still-growing cycles participate;
-- a cycle receives credits only for runs after it began.
DO $$
DECLARE
  t RECORD;
  v_run_date date;
  v_daily numeric;
  v_first_missed_run date;
BEGIN
  FOR t IN
    SELECT tr.id, tr.user_id, tr.currency, tr.remaining, tr.created_at
    FROM public.deposit_tranches tr
    WHERE tr.status = 'locked'
      AND tr.approved = true
      AND tr.maturity_date > now()
      AND tr.remaining > 0
      AND tr.current_balance > 0
      AND EXISTS (SELECT 1 FROM auth.users u WHERE u.id = tr.user_id)
  LOOP
    v_daily := round((t.remaining * 0.01)::numeric, 2);
    v_first_missed_run := greatest(
      date '2026-08-01',
      ((t.created_at AT TIME ZONE 'Africa/Johannesburg')::date + 1)
    );

    FOR v_run_date IN
      SELECT generate_series(v_first_missed_run, date '2026-08-04', interval '1 day')::date
    LOOP
      IF v_daily <= 0 THEN CONTINUE; END IF;

      UPDATE public.deposit_tranches
      SET current_balance = current_balance + v_daily
      WHERE id = t.id;

      INSERT INTO public.transactions (
        user_id, type, currency, amount, status, description, created_at
      ) VALUES (
        t.user_id, 'bonus', t.currency, v_daily, 'completed',
        'Account top up (1% daily incentive — missed scheduled run)',
        (v_run_date::timestamp AT TIME ZONE 'Africa/Johannesburg')
      );
    END LOOP;
  END LOOP;
END;
$$;
