-- A tranche originally had no foreign key to auth.users.  That allowed an
-- account deletion to leave an orphaned cycle behind.  Remove those legacy
-- rows, then make future account deletion cascade through every cycle ledger.
DELETE FROM public.deposit_tranches t
WHERE NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = t.user_id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.deposit_tranches'::regclass
      AND conname = 'deposit_tranches_user_id_auth_fkey'
  ) THEN
    ALTER TABLE public.deposit_tranches
      ADD CONSTRAINT deposit_tranches_user_id_auth_fkey
      FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
  END IF;
END;
$$;

-- A deferred wallet/transaction trigger may run while a cascading auth delete
-- is in progress.  A missing profile is normal in that case and must not make
-- the deletion (or an unrelated scheduled run) fail.
CREATE OR REPLACE FUNCTION public.refresh_wallet_health_from_activity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_user_id uuid; v_currency text; v_status public.tx_status;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_user_id := OLD.user_id; v_currency := OLD.currency;
    v_status := CASE WHEN TG_TABLE_NAME = 'transactions' THEN OLD.status ELSE NULL END;
  ELSE
    v_user_id := NEW.user_id; v_currency := NEW.currency;
    v_status := CASE WHEN TG_TABLE_NAME = 'transactions' THEN NEW.status ELSE NULL END;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = v_user_id) THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  IF v_currency = 'ZAR' AND (TG_TABLE_NAME = 'wallets' OR TG_OP <> 'INSERT' OR v_status = 'completed') THEN
    PERFORM public.record_wallet_health_snapshot(v_user_id);
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

-- Each cycle is handled in its own exception block.  A malformed legacy row
-- can therefore be logged and skipped, but can never halt daily top-ups or
-- maturity processing for every other member.
CREATE OR REPLACE FUNCTION public.apply_daily_tranche_incentive()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE t record; p record; daily numeric; gain numeric;
  v_date date := (now() AT TIME ZONE 'Africa/Johannesburg')::date;
  v_withdrawable numeric; v_streak integer; v_checked_user uuid; v_tx_id uuid;
BEGIN
  FOR t IN SELECT * FROM public.deposit_tranches
    WHERE status='locked' AND approved=true AND maturity_date>now() AND remaining>0 AND current_balance>0
    FOR UPDATE SKIP LOCKED
  LOOP
    BEGIN
      daily := round((t.remaining * .01)::numeric, 2);
      IF daily <= 0 THEN CONTINUE; END IF;
      INSERT INTO public.tranche_daily_incentives(tranche_id,incentive_date,amount)
      VALUES(t.id,v_date,daily) ON CONFLICT DO NOTHING;
      IF NOT FOUND THEN CONTINUE; END IF;
      UPDATE public.deposit_tranches SET current_balance=current_balance+daily WHERE id=t.id;
      INSERT INTO public.transactions(user_id,type,currency,amount,status,description,reference)
      VALUES(t.user_id,'bonus',t.currency,daily,'completed','Account top up (1% daily incentive)',
        'TRANCHE-'||t.id::text||'-'||to_char(v_date,'YYYYMMDD'));
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'Skipped daily incentive for tranche %: %', t.id, SQLERRM;
    END;
  END LOOP;

  FOR t IN SELECT * FROM public.deposit_tranches
    WHERE status='locked' AND approved=true AND maturity_date<=now() AND remaining>0 AND current_balance>0
    FOR UPDATE SKIP LOCKED
  LOOP
    BEGIN
      gain := greatest(0,COALESCE(t.current_balance,t.remaining)-t.remaining);
      INSERT INTO public.tranche_maturity_settlements(tranche_id,gain) VALUES(t.id,gain) ON CONFLICT DO NOTHING;
      IF NOT FOUND THEN CONTINUE; END IF;
      IF gain > 0 THEN
        UPDATE public.wallets SET balance=balance+gain,updated_at=now()
        WHERE user_id=t.user_id AND currency=t.currency;
        IF NOT FOUND THEN RAISE EXCEPTION 'Maturity wallet is missing'; END IF;
        INSERT INTO public.transactions(user_id,type,currency,amount,status,description,reference)
        VALUES(t.user_id,'bonus',t.currency,gain,'completed','Matured tranche incentive (30-day cycle)',
          'MATURITY-'||t.id::text);
      END IF;
      UPDATE public.deposit_tranches SET status='matured',current_balance=remaining WHERE id=t.id;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'Skipped maturity for tranche %: %', t.id, SQLERRM;
    END;
  END LOOP;

  FOR p IN SELECT id FROM public.profiles LOOP
    BEGIN
      PERFORM public.record_wallet_health_snapshot(p.id);
      SELECT withdrawable_zar INTO v_withdrawable FROM public.wallet_health_daily
      WHERE user_id=p.id AND snapshot_date=v_date;
      INSERT INTO public.wallet_health_reward_days(user_id,snapshot_date)
      VALUES(p.id,v_date) ON CONFLICT DO NOTHING RETURNING user_id INTO v_checked_user;
      IF v_checked_user IS NULL THEN CONTINUE; END IF;
      IF COALESCE(v_withdrawable,0) >= 2000 THEN
        UPDATE public.profiles SET reward_streak_days=reward_streak_days+1
        WHERE id=p.id RETURNING reward_streak_days INTO v_streak;
        IF v_streak >= 30 THEN
          INSERT INTO public.transactions(user_id,type,currency,amount,status,description)
          VALUES(p.id,'bonus','ZAR',9.99,'completed','Wallet health reward - 1 point (30-day R2,000 hold)') RETURNING id INTO v_tx_id;
          INSERT INTO public.wallet_reward_credits(user_id,qualifying_date,points,value,transaction_id)
          VALUES(p.id,v_date,1,9.99,v_tx_id) ON CONFLICT DO NOTHING;
          IF FOUND THEN
            UPDATE public.wallets SET balance=balance+9.99,updated_at=now() WHERE user_id=p.id AND currency='ZAR';
            UPDATE public.profiles SET reward_points=reward_points+1,reward_streak_days=0 WHERE id=p.id;
            UPDATE public.wallet_health_daily SET reward_credit=reward_credit+9.99 WHERE user_id=p.id AND snapshot_date=v_date;
          END IF;
        END IF;
      ELSE
        UPDATE public.profiles SET reward_streak_days=0 WHERE id=p.id;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'Skipped wallet-health processing for user %: %', p.id, SQLERRM;
    END;
  END LOOP;
END;
$$;

-- Recover the missed 21 August 2026 nightly credit without ever duplicating a
-- tranche/date already processed.  Today's normal run follows immediately.
DO $$
DECLARE t record; v_day date := DATE '2026-08-21'; v_daily numeric;
BEGIN
  FOR t IN SELECT * FROM public.deposit_tranches
    WHERE status='locked' AND approved=true AND remaining>0 AND current_balance>0
      AND maturity_date > (v_day::timestamp AT TIME ZONE 'Africa/Johannesburg')
      AND created_at < ((v_day + 1)::timestamp AT TIME ZONE 'Africa/Johannesburg')
  LOOP
    BEGIN
      v_daily := round((t.remaining * .01)::numeric, 2);
      IF v_daily <= 0 THEN CONTINUE; END IF;
      INSERT INTO public.tranche_daily_incentives(tranche_id,incentive_date,amount)
      VALUES(t.id,v_day,v_daily) ON CONFLICT DO NOTHING;
      IF NOT FOUND THEN CONTINUE; END IF;
      UPDATE public.deposit_tranches SET current_balance=current_balance+v_daily WHERE id=t.id;
      INSERT INTO public.transactions(user_id,type,currency,amount,status,description,reference,created_at)
      VALUES(t.user_id,'bonus',t.currency,v_daily,'completed','Account top up (1% daily incentive — recovered missed run)',
        'TRANCHE-'||t.id::text||'-'||to_char(v_day,'YYYYMMDD'),
        (v_day::timestamp AT TIME ZONE 'Africa/Johannesburg'));
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'Could not recover tranche % for %: %',t.id,v_day,SQLERRM;
    END;
  END LOOP;
END;
$$;

SELECT public.apply_daily_tranche_incentive();

REVOKE ALL ON FUNCTION public.apply_daily_tranche_incentive() FROM PUBLIC, anon, authenticated;
