-- Maturity is presented to members and administrators as a Johannesburg
-- calendar date. Previously settlement compared the full approval timestamp,
-- while the daily job ran only at 00:00 SAST. A cycle due later that day got
-- its final growth credit at midnight but remained locked until a refresh
-- after its exact approval time (or the following night's job).
--
-- Settle on the displayed local date instead. The daily-credit insert remains
-- the idempotency guard, so a member refresh racing the cron job cannot apply
-- growth twice.
CREATE OR REPLACE FUNCTION public.normalize_tranche_maturity_to_sast_midnight()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.status = 'locked' THEN
    NEW.maturity_date := (
      (NEW.maturity_date AT TIME ZONE 'Africa/Johannesburg')::date::timestamp
      AT TIME ZONE 'Africa/Johannesburg'
    );
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS normalize_tranche_maturity_to_sast_midnight
  ON public.deposit_tranches;
CREATE TRIGGER normalize_tranche_maturity_to_sast_midnight
BEFORE INSERT OR UPDATE OF maturity_date ON public.deposit_tranches
FOR EACH ROW
EXECUTE FUNCTION public.normalize_tranche_maturity_to_sast_midnight();

-- Align existing locked cycles with the date members were promised. In UTC,
-- Johannesburg midnight is 22:00 on the preceding calendar day.
UPDATE public.deposit_tranches
SET maturity_date = (
  (maturity_date AT TIME ZONE 'Africa/Johannesburg')::date::timestamp
  AT TIME ZONE 'Africa/Johannesburg'
)
WHERE status = 'locked'
  AND maturity_date IS DISTINCT FROM (
    (maturity_date AT TIME ZONE 'Africa/Johannesburg')::date::timestamp
    AT TIME ZONE 'Africa/Johannesburg'
  );

CREATE OR REPLACE FUNCTION public.settle_due_tranches_for_user(p_user_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tranche public.deposit_tranches%ROWTYPE;
  v_today date := (now() AT TIME ZONE 'Africa/Johannesburg')::date;
  v_daily numeric;
  v_accrued numeric;
  v_gain numeric;
  v_settled integer := 0;
BEGIN
  FOR v_tranche IN
    SELECT *
    FROM public.deposit_tranches
    WHERE user_id = p_user_id
      AND status = 'locked'
      AND approved = true
      AND (maturity_date AT TIME ZONE 'Africa/Johannesburg')::date <= v_today
      AND remaining > 0
      AND current_balance > 0
    ORDER BY maturity_date, created_at
    FOR UPDATE
  LOOP
    BEGIN
      -- A member can refresh just before the midnight cron has added the last
      -- daily credit. Add that credit here on the due date when needed.
      IF (v_tranche.maturity_date AT TIME ZONE 'Africa/Johannesburg')::date = v_today THEN
        v_accrued := greatest(
          0,
          COALESCE(v_tranche.current_balance, v_tranche.remaining) - v_tranche.remaining
        );
        v_daily := round(
          (v_tranche.remaining * COALESCE(v_tranche.daily_rate, 0.01))::numeric,
          2
        );

        IF v_tranche.target_gain IS NOT NULL THEN
          v_daily := least(
            v_daily,
            greatest(0, v_tranche.target_gain - v_accrued)
          );
        END IF;

        IF v_daily > 0 THEN
          INSERT INTO public.tranche_daily_incentives (
            tranche_id, incentive_date, amount
          ) VALUES (
            v_tranche.id, v_today, v_daily
          )
          ON CONFLICT DO NOTHING;

          IF FOUND THEN
            UPDATE public.deposit_tranches
            SET current_balance = current_balance + v_daily
            WHERE id = v_tranche.id;

            v_tranche.current_balance := v_tranche.current_balance + v_daily;

            INSERT INTO public.transactions (
              user_id, type, currency, amount, status, description, reference
            ) VALUES (
              v_tranche.user_id,
              'bonus',
              v_tranche.currency,
              v_daily,
              'completed',
              'Daily growth credit - ' || COALESCE(v_tranche.cycle_label, 'growth cycle'),
              'TRANCHE-' || v_tranche.id::text || '-' || to_char(v_today, 'YYYYMMDD')
            );
          END IF;
        END IF;
      END IF;

      v_gain := greatest(
        0,
        COALESCE(
          v_tranche.target_gain,
          COALESCE(v_tranche.current_balance, v_tranche.remaining) - v_tranche.remaining
        )
      );

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
          p_user_id,
          'bonus',
          v_tranche.currency,
          v_gain,
          'completed',
          'Matured growth - ' || COALESCE(v_tranche.cycle_label, 'growth cycle'),
          'MATURITY-' || v_tranche.id::text
        );
      END IF;

      UPDATE public.deposit_tranches
      SET status = 'matured',
          current_balance = remaining
      WHERE id = v_tranche.id;

      v_settled := v_settled + 1;
    EXCEPTION WHEN OTHERS THEN
      -- Keep a malformed cycle locked rather than partially releasing it.
      RAISE WARNING 'Skipped maturity for tranche %: %', v_tranche.id, SQLERRM;
    END;
  END LOOP;

  RETURN v_settled;
END;
$$;

CREATE OR REPLACE FUNCTION public.apply_daily_tranche_incentive()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  t record;
  p record;
  daily numeric;
  accrued numeric;
  v_date date := (now() AT TIME ZONE 'Africa/Johannesburg')::date;
  v_withdrawable numeric;
  v_streak integer;
  v_checked_user uuid;
  v_tx_id uuid;
BEGIN
  -- Include the local maturity date so the final daily credit is recorded
  -- before the cycle is released below. The unique daily row prevents a
  -- duplicate when settle_due_tranches_for_user already handled it.
  FOR t IN
    SELECT *
    FROM public.deposit_tranches
    WHERE status = 'locked'
      AND approved = true
      AND (maturity_date AT TIME ZONE 'Africa/Johannesburg')::date >= v_date
      AND remaining > 0
      AND current_balance > 0
      AND EXISTS (
        SELECT 1 FROM auth.users u WHERE u.id = deposit_tranches.user_id
      )
    FOR UPDATE SKIP LOCKED
  LOOP
    BEGIN
      accrued := greatest(
        0,
        COALESCE(t.current_balance, t.remaining) - t.remaining
      );
      daily := round((t.remaining * COALESCE(t.daily_rate, 0.01))::numeric, 2);

      IF t.target_gain IS NOT NULL THEN
        daily := least(daily, greatest(0, t.target_gain - accrued));
      END IF;

      IF daily <= 0 THEN
        CONTINUE;
      END IF;

      INSERT INTO public.tranche_daily_incentives (
        tranche_id, incentive_date, amount
      ) VALUES (
        t.id, v_date, daily
      )
      ON CONFLICT DO NOTHING;

      IF NOT FOUND THEN
        CONTINUE;
      END IF;

      UPDATE public.deposit_tranches
      SET current_balance = current_balance + daily
      WHERE id = t.id;

      INSERT INTO public.transactions (
        user_id, type, currency, amount, status, description, reference
      ) VALUES (
        t.user_id,
        'bonus',
        t.currency,
        daily,
        'completed',
        'Daily growth credit - ' || COALESCE(t.cycle_label, 'growth cycle'),
        'TRANCHE-' || t.id::text || '-' || to_char(v_date, 'YYYYMMDD')
      );
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'Skipped daily incentive for tranche %: %', t.id, SQLERRM;
    END;
  END LOOP;

  -- Settlement itself owns the idempotency guard and uses local-date
  -- semantics, both for the cron run and for member-triggered refreshes.
  FOR t IN
    SELECT DISTINCT user_id
    FROM public.deposit_tranches
    WHERE status = 'locked'
      AND approved = true
      AND (maturity_date AT TIME ZONE 'Africa/Johannesburg')::date <= v_date
      AND remaining > 0
      AND current_balance > 0
      AND EXISTS (
        SELECT 1 FROM auth.users u WHERE u.id = deposit_tranches.user_id
      )
  LOOP
    PERFORM public.settle_due_tranches_for_user(t.user_id);
  END LOOP;

  FOR p IN SELECT id FROM public.profiles LOOP
    BEGIN
      PERFORM public.record_wallet_health_snapshot(p.id);

      SELECT withdrawable_zar
      INTO v_withdrawable
      FROM public.wallet_health_daily
      WHERE user_id = p.id
        AND snapshot_date = v_date;

      v_checked_user := NULL;
      INSERT INTO public.wallet_health_reward_days (user_id, snapshot_date)
      VALUES (p.id, v_date)
      ON CONFLICT DO NOTHING
      RETURNING user_id INTO v_checked_user;

      IF v_checked_user IS NULL THEN
        CONTINUE;
      END IF;

      IF COALESCE(v_withdrawable, 0) >= 2000 THEN
        UPDATE public.profiles
        SET reward_streak_days = reward_streak_days + 1
        WHERE id = p.id
        RETURNING reward_streak_days INTO v_streak;

        IF v_streak >= 30 THEN
          INSERT INTO public.transactions (
            user_id, type, currency, amount, status, description
          ) VALUES (
            p.id,
            'bonus',
            'ZAR',
            9.99,
            'completed',
            'Wallet health reward - 1 point (30-day R2,000 hold)'
          )
          RETURNING id INTO v_tx_id;

          INSERT INTO public.wallet_reward_credits (
            user_id, qualifying_date, points, value, transaction_id
          ) VALUES (
            p.id, v_date, 1, 9.99, v_tx_id
          )
          ON CONFLICT DO NOTHING;

          IF FOUND THEN
            UPDATE public.wallets
            SET balance = balance + 9.99,
                updated_at = now()
            WHERE user_id = p.id
              AND currency = 'ZAR';

            UPDATE public.profiles
            SET reward_points = reward_points + 1,
                reward_streak_days = 0
            WHERE id = p.id;

            UPDATE public.wallet_health_daily
            SET reward_credit = reward_credit + 9.99
            WHERE user_id = p.id
              AND snapshot_date = v_date;
          END IF;
        END IF;
      ELSE
        UPDATE public.profiles
        SET reward_streak_days = 0
        WHERE id = p.id;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'Skipped wallet-health processing for user %: %', p.id, SQLERRM;
    END;
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION public.settle_due_tranches_for_user(uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.apply_daily_tranche_incentive()
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.normalize_tranche_maturity_to_sast_midnight()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.settle_due_tranches_for_user(uuid)
  TO service_role;

-- Recreate the job explicitly so deployments do not depend on the original
-- 2026 schedule still being present. pg_cron expressions are UTC, therefore
-- 22:00 UTC is 00:00 in Johannesburg throughout the year.
DO $$
DECLARE
  v_job bigint;
BEGIN
  FOR v_job IN
    SELECT jobid
    FROM cron.job
    WHERE jobname = 'daily-tranche-incentive'
  LOOP
    PERFORM cron.unschedule(v_job);
  END LOOP;

  PERFORM cron.schedule(
    'daily-tranche-incentive',
    '0 22 * * *',
    $job$SELECT public.apply_daily_tranche_incentive();$job$
  );
END;
$$;

-- Repair cycles already stuck on their displayed maturity date. Both the
-- daily growth and maturity settlement tables make this safe to rerun.
SELECT public.apply_daily_tranche_incentive();
