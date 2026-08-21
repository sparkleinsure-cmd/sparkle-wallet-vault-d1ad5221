-- Keep every deposited cycle intact until its full 30-day term has elapsed.
-- Maturity is settled as one database transaction: the principal becomes
-- available by unlocking the tranche and its earned gain is credited at the
-- same instant.  The settlement row makes a retry/concurrent cron harmless.
CREATE TABLE IF NOT EXISTS public.tranche_maturity_settlements (
  tranche_id uuid PRIMARY KEY REFERENCES public.deposit_tranches(id) ON DELETE CASCADE,
  gain numeric(18,2) NOT NULL CHECK (gain >= 0),
  settled_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.tranche_maturity_settlements ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.tranche_maturity_settlements FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.tranche_maturity_settlements TO service_role;

-- A repayment can be collected more than once over the life of an insurance
-- claim.  Reusing the claim id as the transaction reference violated the
-- per-user unique-reference constraint on the second collection and aborted
-- the withdrawal request.  The claim row lock is the idempotency guard; these
-- ledger rows deliberately have no reusable reference.
CREATE OR REPLACE FUNCTION public.collect_insurance_repayment(p_user_id uuid)
RETURNS numeric LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE
  v_claim public.insurance_claims%ROWTYPE;
  v_app public.insurance_applications%ROWTYPE;
  v_wallet public.wallets%ROWTYPE;
  v_locked numeric := 0; v_available numeric := 0; v_due numeric := 0; v_collect numeric := 0;
BEGIN
  SELECT * INTO v_claim FROM public.insurance_claims
  WHERE user_id=p_user_id AND repayment_status='active' ORDER BY reviewed_at LIMIT 1 FOR UPDATE;
  IF NOT FOUND THEN RETURN 0; END IF;
  SELECT * INTO v_wallet FROM public.wallets WHERE user_id=p_user_id AND currency='ZAR' FOR UPDATE;
  IF NOT FOUND THEN RETURN 0; END IF;
  SELECT COALESCE(sum(remaining),0) INTO v_locked FROM public.deposit_tranches
  WHERE user_id=p_user_id AND currency='ZAR' AND status='locked' AND maturity_date>now() AND remaining>0;
  v_available := greatest(0, v_wallet.balance-v_locked);
  v_due := greatest(0, v_claim.repayment_total-v_claim.repayment_paid);
  v_collect := least(v_available, v_due, v_claim.instalment_amount);
  IF v_collect <= 0 THEN RETURN 0; END IF;
  UPDATE public.wallets SET balance=balance-v_collect, updated_at=now() WHERE id=v_wallet.id;
  UPDATE public.insurance_claims SET repayment_paid=repayment_paid+v_collect,
    repayment_status=CASE WHEN repayment_paid+v_collect>=repayment_total THEN 'paid' ELSE 'active' END
  WHERE id=v_claim.id;
  INSERT INTO public.transactions(user_id,type,currency,amount,status,description)
  VALUES(p_user_id,'fee','ZAR',v_collect,'completed','Insurance credit repayment - '||v_claim.item);
  IF v_claim.repayment_paid+v_collect>=v_claim.repayment_total THEN
    SELECT * INTO v_app FROM public.insurance_applications WHERE id=v_claim.application_id FOR UPDATE;
    UPDATE public.insurance_applications SET credit_available=credit_limit,updated_at=now() WHERE id=v_app.id;
  END IF;
  RETURN v_collect;
END;
$$;

CREATE OR REPLACE FUNCTION public.request_withdrawal_secure(
  p_amount numeric, p_currency text, p_bank_name text DEFAULT NULL,
  p_account_number text DEFAULT NULL, p_confirm_break boolean DEFAULT false
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_wallet public.wallets%ROWTYPE; v_profile public.profiles%ROWTYPE;
  v_locked numeric := 0; v_withdrawable numeric; v_tx uuid;
BEGIN
  IF auth.uid() IS NULL OR p_currency NOT IN ('ZAR','USD') OR p_amount<=0 OR p_amount>10000000 THEN RAISE EXCEPTION 'Invalid withdrawal request'; END IF;
  SELECT * INTO v_wallet FROM public.wallets WHERE user_id=auth.uid() AND currency=p_currency FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Wallet not found'; END IF;
  SELECT * INTO v_profile FROM public.profiles WHERE id=auth.uid();
  IF NOT FOUND OR v_profile.kyc_status<>'verified' THEN RAISE EXCEPTION 'Identity review must be approved before withdrawal'; END IF;
  IF length(trim(COALESCE(v_profile.bank_name,'')))<2 OR trim(COALESCE(v_profile.bank_account_number,''))!~'^[0-9]{4,40}$' THEN RAISE EXCEPTION 'Add your registered payout details in Settings before withdrawing'; END IF;
  SELECT COALESCE(sum(remaining),0) INTO v_locked FROM public.deposit_tranches
  WHERE user_id=auth.uid() AND currency=p_currency AND status='locked' AND maturity_date>now() AND remaining>0;
  v_withdrawable:=greatest(0,v_wallet.balance-v_locked);
  IF p_amount>v_withdrawable THEN RAISE EXCEPTION 'Only matured funds are withdrawable. Locked 30-day cycles cannot be withdrawn early.'; END IF;
  INSERT INTO public.transactions(user_id,type,currency,amount,status,description,reference)
  VALUES(auth.uid(),'withdrawal',p_currency,round(p_amount,2),'pending',
    'Withdrawal request - '||v_profile.bank_name||' account ending '||right(v_profile.bank_account_number,4),
    'WITHDRAWAL-'||gen_random_uuid()::text) RETURNING id INTO v_tx;
  UPDATE public.wallets SET balance=balance-p_amount,updated_at=now() WHERE id=v_wallet.id;
  RETURN jsonb_build_object('grossAmount',p_amount,'penalty',0,'payoutAmount',p_amount,
    'accountLast4',right(v_profile.bank_account_number,4),'withdrawalId',v_tx);
END;
$$;

CREATE OR REPLACE FUNCTION public.apply_daily_tranche_incentive()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE t record; p record; daily numeric; gain numeric; v_date date := (now() AT TIME ZONE 'Africa/Johannesburg')::date;
  v_withdrawable numeric; v_streak integer; v_checked_user uuid; v_tx_id uuid;
BEGIN
  FOR t IN SELECT * FROM public.deposit_tranches
    WHERE status='locked' AND approved=true AND maturity_date>now() AND remaining>0 AND current_balance>0
      AND EXISTS (SELECT 1 FROM auth.users u WHERE u.id=deposit_tranches.user_id)
    FOR UPDATE SKIP LOCKED
  LOOP
    daily:=round((t.remaining*.01)::numeric,2); IF daily<=0 THEN CONTINUE; END IF;
    INSERT INTO public.tranche_daily_incentives(tranche_id,incentive_date,amount) VALUES(t.id,v_date,daily) ON CONFLICT DO NOTHING;
    IF NOT FOUND THEN CONTINUE; END IF;
    UPDATE public.deposit_tranches SET current_balance=current_balance+daily WHERE id=t.id;
    INSERT INTO public.transactions(user_id,type,currency,amount,status,description,reference)
      VALUES(t.user_id,'bonus',t.currency,daily,'completed','Account top up (1% daily incentive)','TRANCHE-'||t.id::text||'-'||to_char(v_date,'YYYYMMDD'));
  END LOOP;
  FOR t IN SELECT * FROM public.deposit_tranches
    WHERE status='locked' AND approved=true AND maturity_date<=now() AND remaining>0 AND current_balance>0
      AND EXISTS (SELECT 1 FROM auth.users u WHERE u.id=deposit_tranches.user_id)
    FOR UPDATE SKIP LOCKED
  LOOP
    gain:=greatest(0,COALESCE(t.current_balance,t.remaining)-t.remaining);
    INSERT INTO public.tranche_maturity_settlements(tranche_id,gain) VALUES(t.id,gain) ON CONFLICT DO NOTHING;
    IF NOT FOUND THEN CONTINUE; END IF;
    IF gain>0 THEN
      UPDATE public.wallets SET balance=balance+gain,updated_at=now() WHERE user_id=t.user_id AND currency=t.currency;
      INSERT INTO public.transactions(user_id,type,currency,amount,status,description,reference)
      VALUES(t.user_id,'bonus',t.currency,gain,'completed','Matured tranche incentive (30-day cycle)','MATURITY-'||t.id::text);
    END IF;
    UPDATE public.deposit_tranches SET status='matured',current_balance=remaining WHERE id=t.id;
  END LOOP;
  FOR p IN SELECT p.id FROM public.profiles p WHERE EXISTS (SELECT 1 FROM auth.users u WHERE u.id=p.id) LOOP
    BEGIN
      PERFORM public.record_wallet_health_snapshot(p.id);
      SELECT withdrawable_zar INTO v_withdrawable FROM public.wallet_health_daily WHERE user_id=p.id AND snapshot_date=v_date;
      INSERT INTO public.wallet_health_reward_days(user_id,snapshot_date) VALUES(p.id,v_date) ON CONFLICT DO NOTHING RETURNING user_id INTO v_checked_user;
      IF v_checked_user IS NULL THEN CONTINUE; END IF;
      IF COALESCE(v_withdrawable,0)>=2000 THEN
        UPDATE public.profiles SET reward_streak_days=reward_streak_days+1 WHERE id=p.id RETURNING reward_streak_days INTO v_streak;
        IF v_streak>=30 THEN
          INSERT INTO public.transactions(user_id,type,currency,amount,status,description) VALUES(p.id,'bonus','ZAR',9.99,'completed','Wallet health reward - 1 point (30-day R2,000 hold)') RETURNING id INTO v_tx_id;
          INSERT INTO public.wallet_reward_credits(user_id,qualifying_date,points,value,transaction_id) VALUES(p.id,v_date,1,9.99,v_tx_id) ON CONFLICT DO NOTHING;
          IF FOUND THEN UPDATE public.wallets SET balance=balance+9.99,updated_at=now() WHERE user_id=p.id AND currency='ZAR'; UPDATE public.profiles SET reward_points=reward_points+1,reward_streak_days=0 WHERE id=p.id; UPDATE public.wallet_health_daily SET reward_credit=reward_credit+9.99 WHERE user_id=p.id AND snapshot_date=v_date; END IF;
        END IF;
      ELSE UPDATE public.profiles SET reward_streak_days=0 WHERE id=p.id; END IF;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'Skipped wallet-health processing for user %: %',p.id,SQLERRM;
    END;
  END LOOP;
END;
$$;

-- Correct the reported R400 duplicate credit once, and only while the exact
-- reported account still has the reported R6,400 liquid balance.
DO $$
DECLARE v_user uuid;
BEGIN
  SELECT p.id INTO v_user FROM public.profiles p WHERE p.account_id='UE38UQ3M';
  IF v_user IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.wallets WHERE user_id=v_user AND currency='ZAR' AND balance=6400)
     AND NOT EXISTS (SELECT 1 FROM public.deposit_tranches WHERE user_id=v_user AND currency='ZAR' AND status='locked' AND maturity_date>now() AND remaining>0)
     AND NOT EXISTS (SELECT 1 FROM public.transactions WHERE user_id=v_user AND reference='RECONCILE-UE38UQ3M-20260822') THEN
    UPDATE public.wallets SET balance=balance-400,updated_at=now() WHERE user_id=v_user AND currency='ZAR';
    INSERT INTO public.transactions(user_id,type,currency,amount,status,description,reference)
    VALUES(v_user,'fee','ZAR',400,'completed','Balance reconciliation - duplicate maturity credit removed','RECONCILE-UE38UQ3M-20260822');
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.collect_insurance_repayment(uuid), public.request_withdrawal_secure(numeric,text,text,text,boolean), public.apply_daily_tranche_incentive() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.request_withdrawal_secure(numeric,text,text,text,boolean) TO authenticated;
