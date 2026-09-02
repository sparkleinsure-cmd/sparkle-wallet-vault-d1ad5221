-- Every new growth cycle stores an immutable snapshot of the terms selected
-- by the member. Product changes can therefore never alter an active cycle.
CREATE TABLE IF NOT EXISTS public.growth_cycle_products (
  code text PRIMARY KEY,
  label text NOT NULL,
  term_days integer NOT NULL CHECK (term_days > 0),
  min_amount numeric(18,2) NOT NULL CHECK (min_amount > 0),
  max_amount numeric(18,2) NOT NULL CHECK (max_amount >= min_amount),
  daily_rate numeric(18,12) NOT NULL CHECK (daily_rate > 0),
  total_growth_rate numeric(18,12) NOT NULL CHECK (total_growth_rate > 0),
  sort_order integer NOT NULL,
  active boolean NOT NULL DEFAULT true,
  CHECK (abs((daily_rate * term_days) - total_growth_rate) < 0.000001)
);

INSERT INTO public.growth_cycle_products (
  code, label, term_days, min_amount, max_amount, daily_rate,
  total_growth_rate, sort_order, active
) VALUES
  ('legacy_30d', '30 Days (legacy)', 30, 0.01, 10000000, 0.01, 0.30, 0, false),
  ('15d',  '15 Days',   15, 100,   900,    0.20 / 15,  0.20, 10, true),
  ('30d',  '1 Month',   30, 1000,  9000,   0.40 / 30,  0.40, 20, true),
  ('180d', '6 Months', 180, 10000, 19000,  3.60 / 180, 3.60, 30, true),
  ('360d', '12 Months',360, 20000, 100000,  9.60 / 360,9.60, 40, true)
ON CONFLICT (code) DO UPDATE SET
  label = EXCLUDED.label,
  term_days = EXCLUDED.term_days,
  min_amount = EXCLUDED.min_amount,
  max_amount = EXCLUDED.max_amount,
  daily_rate = EXCLUDED.daily_rate,
  total_growth_rate = EXCLUDED.total_growth_rate,
  sort_order = EXCLUDED.sort_order,
  active = EXCLUDED.active;

ALTER TABLE public.growth_cycle_products ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.growth_cycle_products FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.growth_cycle_products TO service_role;

ALTER TABLE public.transactions
  ADD COLUMN IF NOT EXISTS growth_cycle_code text REFERENCES public.growth_cycle_products(code);

ALTER TABLE public.deposit_tranches
  ADD COLUMN IF NOT EXISTS growth_cycle_code text REFERENCES public.growth_cycle_products(code),
  ADD COLUMN IF NOT EXISTS cycle_label text,
  ADD COLUMN IF NOT EXISTS term_days integer,
  ADD COLUMN IF NOT EXISTS daily_rate numeric(18,12),
  ADD COLUMN IF NOT EXISTS target_gain numeric(18,2);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='deposit_tranches_cycle_term_positive') THEN
    ALTER TABLE public.deposit_tranches ADD CONSTRAINT deposit_tranches_cycle_term_positive
      CHECK (term_days IS NULL OR term_days > 0) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='deposit_tranches_daily_rate_positive') THEN
    ALTER TABLE public.deposit_tranches ADD CONSTRAINT deposit_tranches_daily_rate_positive
      CHECK (daily_rate IS NULL OR daily_rate > 0) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='deposit_tranches_target_gain_nonnegative') THEN
    ALTER TABLE public.deposit_tranches ADD CONSTRAINT deposit_tranches_target_gain_nonnegative
      CHECK (target_gain IS NULL OR target_gain >= 0) NOT VALID;
  END IF;
END;
$$;

-- Existing active cycles retain the original 30-day, 1%-per-day behaviour.
-- target_gain remains NULL so their already-accrued value is settled exactly
-- as it was before this migration.
UPDATE public.deposit_tranches
SET growth_cycle_code = 'legacy_30d',
    cycle_label = '30 Days (legacy)',
    term_days = 30,
    daily_rate = 0.01
WHERE status = 'locked'
  AND approved = true
  AND source IN ('deposit', 'transfer')
  AND growth_cycle_code IS NULL;

CREATE OR REPLACE FUNCTION public.submit_deposit_secure(
  p_amount numeric,
  p_currency text,
  p_reference text,
  p_proof_path text,
  p_cycle_code text
)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_tx uuid;
  v_existing public.transactions%ROWTYPE;
  v_product public.growth_cycle_products%ROWTYPE;
  v_amount numeric := round(p_amount, 2);
BEGIN
  IF auth.uid() IS NULL
     OR p_currency <> 'ZAR'
     OR length(trim(COALESCE(p_reference, ''))) NOT BETWEEN 3 AND 200
     OR split_part(COALESCE(p_proof_path, ''), '/', 1) <> auth.uid()::text THEN
    RAISE EXCEPTION 'Invalid deposit request';
  END IF;

  SELECT * INTO v_product
  FROM public.growth_cycle_products
  WHERE code = p_cycle_code AND active = true;
  IF NOT FOUND THEN RAISE EXCEPTION 'Select a valid growth cycle'; END IF;

  IF v_amount < v_product.min_amount THEN
    RAISE EXCEPTION 'Required amount for the % cycle is at least R%',
      v_product.label, trim(to_char(v_product.min_amount, 'FM999G999G999G990D00'));
  END IF;
  IF v_amount > v_product.max_amount THEN
    RAISE EXCEPTION 'Maximum amount for the % cycle is R%',
      v_product.label, trim(to_char(v_product.max_amount, 'FM999G999G999G990D00'));
  END IF;

  SELECT * INTO v_existing
  FROM public.transactions
  WHERE user_id = auth.uid() AND reference = trim(p_reference);
  IF FOUND THEN
    IF v_existing.type = 'deposit'
       AND v_existing.currency = 'ZAR'
       AND v_existing.amount = v_amount
       AND v_existing.growth_cycle_code = p_cycle_code THEN
      RETURN v_existing.id;
    END IF;
    RAISE EXCEPTION 'This deposit reference was already used for different details';
  END IF;

  INSERT INTO public.transactions (
    user_id, type, currency, amount, status, reference, description, proof_url,
    growth_cycle_code
  ) VALUES (
    auth.uid(), 'deposit', 'ZAR', v_amount, 'pending', trim(p_reference),
    'Deposit submitted - awaiting administrator review (' || v_product.label || ')',
    p_proof_path, p_cycle_code
  ) RETURNING id INTO v_tx;
  RETURN v_tx;
EXCEPTION WHEN unique_violation THEN
  SELECT * INTO v_existing
  FROM public.transactions
  WHERE user_id = auth.uid() AND reference = trim(p_reference);
  IF FOUND
     AND v_existing.type = 'deposit'
     AND v_existing.currency = 'ZAR'
     AND v_existing.amount = v_amount
     AND v_existing.growth_cycle_code = p_cycle_code THEN
    RETURN v_existing.id;
  END IF;
  RAISE EXCEPTION 'This deposit reference was already used for different details';
END;
$$;

-- Compatibility for a cached older web build: infer the only matching cycle.
CREATE OR REPLACE FUNCTION public.submit_deposit_secure(
  p_amount numeric, p_currency text, p_reference text, p_proof_path text
)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_code text;
BEGIN
  SELECT code INTO v_code FROM public.growth_cycle_products
  WHERE active = true AND round(p_amount, 2) BETWEEN min_amount AND max_amount
  ORDER BY sort_order LIMIT 1;
  IF v_code IS NULL THEN RAISE EXCEPTION 'Select a cycle and enter an amount within its allowed range'; END IF;
  RETURN public.submit_deposit_secure(p_amount, p_currency, p_reference, p_proof_path, v_code);
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_approve_deposit_secure(
  p_tx_id uuid, p_corrected_amount numeric, p_note text, p_cycle_code text
)
RETURNS numeric LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_tx public.transactions%ROWTYPE;
  v_amount numeric;
  v_selected_code text;
  v_product public.growth_cycle_products%ROWTYPE;
  v_start timestamptz := now();
  v_referral public.referrals%ROWTYPE;
  v_reward numeric;
  v_reward_tx_id uuid;
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(), 'admin'::public.app_role) THEN
    RAISE EXCEPTION 'Forbidden';
  END IF;

  SELECT * INTO v_tx FROM public.transactions WHERE id = p_tx_id FOR UPDATE;
  IF NOT FOUND OR v_tx.type <> 'deposit' OR v_tx.status <> 'pending' THEN
    RAISE EXCEPTION 'Deposit not found or already processed';
  END IF;

  v_selected_code := COALESCE(p_cycle_code, v_tx.growth_cycle_code, 'legacy_30d');
  SELECT * INTO v_product FROM public.growth_cycle_products
  WHERE code = v_selected_code
    AND (active = true OR code = 'legacy_30d');
  IF NOT FOUND THEN RAISE EXCEPTION 'Deposit growth cycle is invalid'; END IF;

  v_amount := round(COALESCE(p_corrected_amount, v_tx.amount), 2);
  IF v_selected_code <> 'legacy_30d' THEN
    IF v_tx.currency <> 'ZAR' THEN RAISE EXCEPTION 'New growth cycles support ZAR only'; END IF;
    IF v_amount < v_product.min_amount THEN
      RAISE EXCEPTION 'Required amount for the % cycle is at least R%',
        v_product.label, trim(to_char(v_product.min_amount, 'FM999G999G999G990D00'));
    END IF;
    IF v_amount > v_product.max_amount THEN
      RAISE EXCEPTION 'Maximum amount for the % cycle is R%',
        v_product.label, trim(to_char(v_product.max_amount, 'FM999G999G999G990D00'));
    END IF;
  ELSIF v_amount < 0.01 OR v_amount > 10000000 THEN
    RAISE EXCEPTION 'Invalid amount';
  END IF;

  UPDATE public.wallets
  SET balance = balance + v_amount, updated_at = v_start
  WHERE user_id = v_tx.user_id AND currency = v_tx.currency;
  IF NOT FOUND THEN RAISE EXCEPTION 'Deposit wallet not found'; END IF;

  UPDATE public.transactions
  SET amount = v_amount,
      status = 'completed',
      growth_cycle_code = v_selected_code,
      description = 'Deposit verified by admin - ' || v_product.label || CASE
        WHEN length(trim(COALESCE(p_note, ''))) > 0 THEN ' - ' || left(trim(p_note), 300)
        ELSE ''
      END
  WHERE id = v_tx.id;

  INSERT INTO public.deposit_tranches (
    user_id, currency, amount, remaining, current_balance, status, source,
    transaction_id, maturity_date, approved, growth_cycle_code, cycle_label,
    term_days, daily_rate, target_gain
  ) VALUES (
    v_tx.user_id, v_tx.currency, v_amount, v_amount, v_amount, 'locked',
    'deposit', v_tx.id, v_start + make_interval(days => v_product.term_days), true,
    v_product.code, v_product.label, v_product.term_days, v_product.daily_rate,
    CASE WHEN v_product.code = 'legacy_30d' THEN NULL
      ELSE round(v_amount * v_product.total_growth_rate, 2) END
  );

  SELECT * INTO v_referral FROM public.referrals
  WHERE referred_user_id = v_tx.user_id AND rewarded_at IS NULL FOR UPDATE;

  IF FOUND
     AND v_referral.created_at <= v_tx.created_at
     AND v_tx.id = (
       SELECT id FROM public.transactions
       WHERE user_id = v_tx.user_id AND type = 'deposit' AND status = 'completed'
       ORDER BY created_at, id LIMIT 1
     ) THEN
    v_reward := round(v_amount * 0.10, 2);
    IF v_reward > 0 THEN
      UPDATE public.wallets SET balance = balance + v_reward, updated_at = v_start
      WHERE user_id = v_referral.referrer_id AND currency = v_tx.currency;
      IF NOT FOUND THEN RAISE EXCEPTION 'Referral wallet not found'; END IF;

      INSERT INTO public.transactions (
        user_id, type, currency, amount, status, description, reference
      ) VALUES (
        v_referral.referrer_id, 'bonus', v_tx.currency, v_reward, 'completed',
        '10% referral bonus', 'REF-' || v_referral.id::text
      ) RETURNING id INTO v_reward_tx_id;

      INSERT INTO public.deposit_tranches (
        user_id, currency, amount, remaining, current_balance, status, source,
        transaction_id, maturity_date, approved, note
      ) VALUES (
        v_referral.referrer_id, v_tx.currency, v_reward, v_reward, v_reward,
        'matured', 'referral', v_reward_tx_id, v_start, true,
        'Immediately withdrawable referral reward'
      );

      UPDATE public.referrals
      SET first_deposit_transaction_id = v_tx.id,
          first_deposit_amount = v_amount,
          reward_amount = v_reward,
          reward_currency = v_tx.currency,
          rewarded_at = v_start
      WHERE id = v_referral.id;
    END IF;
  END IF;

  RETURN v_amount;
END;
$$;

-- Compatibility for an older admin build: retain the cycle submitted by the
-- member (or the original legacy cycle for already-pending deposits).
CREATE OR REPLACE FUNCTION public.admin_approve_deposit_secure(
  p_tx_id uuid, p_corrected_amount numeric DEFAULT NULL, p_note text DEFAULT NULL
)
RETURNS numeric LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  RETURN public.admin_approve_deposit_secure(p_tx_id,p_corrected_amount,p_note,NULL);
END;
$$;

CREATE OR REPLACE FUNCTION public.move_withdrawable_to_growing_idempotent_secure(
  p_amount numeric, p_currency text, p_request_id uuid, p_cycle_code text
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_amount numeric := round(p_amount, 2);
  v_reference text := 'GROW-' || p_request_id::text;
  v_wallet public.wallets%ROWTYPE;
  v_profile public.profiles%ROWTYPE;
  v_product public.growth_cycle_products%ROWTYPE;
  v_existing public.transactions%ROWTYPE;
  v_tranche public.deposit_tranches%ROWTYPE;
  v_locked numeric := 0;
  v_withdrawable numeric;
  v_remaining numeric;
  v_take numeric;
  v_tx uuid;
  v_maturity timestamptz;
  v_target_gain numeric;
BEGIN
  IF auth.uid() IS NULL OR p_currency <> 'ZAR' THEN RAISE EXCEPTION 'Growth cycles support ZAR only'; END IF;

  SELECT * INTO v_product FROM public.growth_cycle_products
  WHERE code = p_cycle_code AND active = true;
  IF NOT FOUND THEN RAISE EXCEPTION 'Select a valid growth cycle'; END IF;
  IF v_amount < v_product.min_amount THEN
    RAISE EXCEPTION 'Required amount for the % cycle is at least R%',
      v_product.label, trim(to_char(v_product.min_amount, 'FM999G999G999G990D00'));
  END IF;
  IF v_amount > v_product.max_amount THEN
    RAISE EXCEPTION 'Maximum amount for the % cycle is R%',
      v_product.label, trim(to_char(v_product.max_amount, 'FM999G999G999G990D00'));
  END IF;

  SELECT * INTO v_profile FROM public.profiles WHERE id = auth.uid();
  IF NOT FOUND THEN RAISE EXCEPTION 'Profile not found'; END IF;
  IF COALESCE(v_profile.account_frozen, false) THEN
    RAISE EXCEPTION 'Your account is frozen while a compliance review is in progress';
  END IF;

  PERFORM public.settle_due_tranches_for_user(auth.uid());

  SELECT * INTO v_wallet FROM public.wallets
  WHERE user_id = auth.uid() AND currency = 'ZAR' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Wallet not found'; END IF;

  SELECT * INTO v_existing FROM public.transactions
  WHERE user_id = auth.uid() AND reference = v_reference;
  IF FOUND THEN
    IF v_existing.type <> 'transfer' OR v_existing.currency <> 'ZAR'
       OR v_existing.amount <> v_amount
       OR v_existing.growth_cycle_code IS DISTINCT FROM p_cycle_code THEN
      RAISE EXCEPTION 'This request identifier was already used for different details';
    END IF;
    SELECT maturity_date, target_gain INTO v_maturity, v_target_gain
    FROM public.deposit_tranches
    WHERE transaction_id = v_existing.id ORDER BY created_at LIMIT 1;
    IF NOT FOUND THEN RAISE EXCEPTION 'Existing growing cycle record is incomplete'; END IF;
    RETURN jsonb_build_object(
      'ok', true, 'amount', v_amount, 'currency', 'ZAR', 'cycleCode', p_cycle_code,
      'cycleLabel', v_product.label, 'maturityDate', v_maturity,
      'expectedAmount', v_amount + COALESCE(v_target_gain, 0),
      'transactionId', v_existing.id, 'replayed', true
    );
  END IF;

  SELECT COALESCE(sum(remaining), 0) INTO v_locked
  FROM public.deposit_tranches
  WHERE user_id = auth.uid() AND currency = 'ZAR'
    AND status = 'locked' AND remaining > 0;
  v_withdrawable := greatest(0, v_wallet.balance - v_locked);
  IF v_amount > v_withdrawable THEN
    RAISE EXCEPTION 'Only withdrawable funds can be moved to growing';
  END IF;

  v_remaining := v_amount;
  FOR v_tranche IN
    SELECT * FROM public.deposit_tranches
    WHERE user_id = auth.uid() AND currency = 'ZAR'
      AND status = 'matured' AND remaining > 0
    ORDER BY maturity_date, created_at FOR UPDATE
  LOOP
    EXIT WHEN v_remaining <= 0;
    v_take := least(v_tranche.remaining, v_remaining);
    UPDATE public.deposit_tranches
    SET remaining = greatest(0, remaining - v_take),
        current_balance = greatest(0, current_balance - v_take),
        status = CASE WHEN remaining - v_take <= 0 THEN 'liquidated' ELSE status END
    WHERE id = v_tranche.id;
    v_remaining := v_remaining - v_take;
  END LOOP;

  v_maturity := now() + make_interval(days => v_product.term_days);
  v_target_gain := round(v_amount * v_product.total_growth_rate, 2);

  INSERT INTO public.transactions (
    user_id, type, currency, amount, status, description, reference, growth_cycle_code
  ) VALUES (
    auth.uid(), 'transfer', 'ZAR', v_amount, 'completed',
    'Moved from withdrawable to growing balance - ' || v_product.label,
    v_reference, p_cycle_code
  ) RETURNING id INTO v_tx;

  INSERT INTO public.deposit_tranches (
    user_id, currency, amount, remaining, current_balance, status, source,
    transaction_id, maturity_date, approved, note, growth_cycle_code,
    cycle_label, term_days, daily_rate, target_gain
  ) VALUES (
    auth.uid(), 'ZAR', v_amount, v_amount, v_amount, 'locked', 'transfer',
    v_tx, v_maturity, true, 'Moved from withdrawable balance', p_cycle_code,
    v_product.label, v_product.term_days, v_product.daily_rate, v_target_gain
  );

  RETURN jsonb_build_object(
    'ok', true, 'amount', v_amount, 'currency', 'ZAR', 'cycleCode', p_cycle_code,
    'cycleLabel', v_product.label, 'maturityDate', v_maturity,
    'expectedAmount', v_amount + v_target_gain,
    'transactionId', v_tx, 'replayed', false
  );
END;
$$;

-- Compatibility for a cached older web build.
CREATE OR REPLACE FUNCTION public.move_withdrawable_to_growing_idempotent_secure(
  p_amount numeric, p_currency text, p_request_id uuid
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_code text;
BEGIN
  SELECT code INTO v_code FROM public.growth_cycle_products
  WHERE active = true AND round(p_amount, 2) BETWEEN min_amount AND max_amount
  ORDER BY sort_order LIMIT 1;
  IF v_code IS NULL THEN RAISE EXCEPTION 'Select a cycle and enter an amount within its allowed range'; END IF;
  RETURN public.move_withdrawable_to_growing_idempotent_secure(p_amount, p_currency, p_request_id, v_code);
END;
$$;

-- An administrator credit attached to an active cycle follows that cycle's
-- daily rate and maturity date. It has no advertised full-cycle target because
-- it may be attached after the cycle has already started.
CREATE OR REPLACE FUNCTION public.admin_credit_bonus_idempotent_secure(
  p_user_id uuid, p_currency text, p_amount numeric, p_note text,
  p_hold_rule text, p_parent_tranche_id uuid, p_request_id uuid
)
RETURNS numeric LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_amount numeric := round(p_amount, 2);
  v_reference text := 'ADMIN-CREDIT-' || p_request_id::text;
  v_maturity timestamptz := now();
  v_parent public.deposit_tranches%ROWTYPE;
  v_balance numeric;
  v_existing public.transactions%ROWTYPE;
  v_tx uuid;
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(), 'admin'::public.app_role) THEN
    RAISE EXCEPTION 'Forbidden';
  END IF;
  IF p_currency NOT IN ('ZAR', 'USD') OR v_amount < 0.01 OR v_amount > 1000000
     OR p_hold_rule NOT IN ('attach', 'instant') THEN
    RAISE EXCEPTION 'Invalid credit';
  END IF;

  IF p_hold_rule = 'attach' THEN
    SELECT * INTO v_parent FROM public.deposit_tranches
    WHERE id=p_parent_tranche_id AND user_id=p_user_id
      AND status='locked' AND remaining>0 FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Active tranche not found'; END IF;
    IF v_parent.currency <> p_currency THEN RAISE EXCEPTION 'Credit currency must match the selected cycle'; END IF;
    v_maturity := v_parent.maturity_date;
  END IF;

  SELECT balance INTO v_balance FROM public.wallets
  WHERE user_id=p_user_id AND currency=p_currency FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Credit wallet not found'; END IF;

  SELECT * INTO v_existing FROM public.transactions
  WHERE user_id=p_user_id AND reference=v_reference;
  IF FOUND THEN
    IF v_existing.type <> 'bonus' OR v_existing.currency <> p_currency
       OR v_existing.amount <> v_amount THEN
      RAISE EXCEPTION 'This request identifier was already used for different details';
    END IF;
    RETURN v_balance;
  END IF;

  UPDATE public.wallets SET balance=balance+v_amount,updated_at=now()
  WHERE user_id=p_user_id AND currency=p_currency RETURNING balance INTO v_balance;

  INSERT INTO public.transactions(user_id,type,currency,amount,status,description,reference)
  VALUES(p_user_id,'bonus',p_currency,v_amount,'completed',
    COALESCE(NULLIF(left(trim(COALESCE(p_note,'')),200),''),'Administrator credit'),v_reference)
  RETURNING id INTO v_tx;

  INSERT INTO public.deposit_tranches(
    user_id,currency,amount,remaining,current_balance,status,source,
    parent_tranche_id,transaction_id,maturity_date,approved,growth_cycle_code,
    cycle_label,term_days,daily_rate,target_gain
  ) VALUES (
    p_user_id,p_currency,v_amount,v_amount,v_amount,
    CASE WHEN p_hold_rule='instant' THEN 'matured' ELSE 'locked' END,
    'bonus',CASE WHEN p_hold_rule='attach' THEN v_parent.id ELSE NULL END,
    v_tx,v_maturity,true,
    CASE WHEN p_hold_rule='attach' THEN v_parent.growth_cycle_code ELSE NULL END,
    CASE WHEN p_hold_rule='attach' THEN v_parent.cycle_label ELSE NULL END,
    CASE WHEN p_hold_rule='attach' THEN v_parent.term_days ELSE NULL END,
    CASE WHEN p_hold_rule='attach' THEN COALESCE(v_parent.daily_rate,0.01) ELSE NULL END,
    NULL
  );

  RETURN v_balance;
END;
$$;

-- Daily accrual is idempotent per Johannesburg calendar date and capped at
-- the cycle's exact target. Maturity uses target_gain, eliminating any cent
-- rounding drift between the displayed expectation and the wallet credit.
CREATE OR REPLACE FUNCTION public.apply_daily_tranche_incentive()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE t record; p record; daily numeric; gain numeric; accrued numeric;
  v_date date := (now() AT TIME ZONE 'Africa/Johannesburg')::date;
  v_withdrawable numeric; v_streak integer; v_checked_user uuid; v_tx_id uuid;
BEGIN
  FOR t IN SELECT * FROM public.deposit_tranches
    WHERE status='locked' AND approved=true AND maturity_date>now() AND remaining>0 AND current_balance>0
      AND EXISTS (SELECT 1 FROM auth.users u WHERE u.id = deposit_tranches.user_id)
    FOR UPDATE SKIP LOCKED
  LOOP
    BEGIN
      accrued := greatest(0, COALESCE(t.current_balance,t.remaining)-t.remaining);
      daily := round((t.remaining * COALESCE(t.daily_rate,0.01))::numeric, 2);
      IF t.target_gain IS NOT NULL THEN
        daily := least(daily, greatest(0, t.target_gain-accrued));
      END IF;
      IF daily <= 0 THEN CONTINUE; END IF;
      INSERT INTO public.tranche_daily_incentives(tranche_id,incentive_date,amount)
      VALUES(t.id,v_date,daily) ON CONFLICT DO NOTHING;
      IF NOT FOUND THEN CONTINUE; END IF;
      UPDATE public.deposit_tranches SET current_balance=current_balance+daily WHERE id=t.id;
      INSERT INTO public.transactions(user_id,type,currency,amount,status,description,reference)
      VALUES(t.user_id,'bonus',t.currency,daily,'completed',
        'Daily growth credit - '||COALESCE(t.cycle_label,'growth cycle'),
        'TRANCHE-'||t.id::text||'-'||to_char(v_date,'YYYYMMDD'));
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'Skipped daily incentive for tranche %: %', t.id, SQLERRM;
    END;
  END LOOP;

  FOR t IN SELECT * FROM public.deposit_tranches
    WHERE status='locked' AND approved=true AND maturity_date<=now() AND remaining>0 AND current_balance>0
      AND EXISTS (SELECT 1 FROM auth.users u WHERE u.id = deposit_tranches.user_id)
    FOR UPDATE SKIP LOCKED
  LOOP
    BEGIN
      gain := greatest(0,COALESCE(t.target_gain,COALESCE(t.current_balance,t.remaining)-t.remaining));
      INSERT INTO public.tranche_maturity_settlements(tranche_id,gain) VALUES(t.id,gain) ON CONFLICT DO NOTHING;
      IF NOT FOUND THEN CONTINUE; END IF;
      IF gain > 0 THEN
        UPDATE public.wallets SET balance=balance+gain,updated_at=now()
        WHERE user_id=t.user_id AND currency=t.currency;
        IF NOT FOUND THEN RAISE EXCEPTION 'Maturity wallet is missing'; END IF;
        INSERT INTO public.transactions(user_id,type,currency,amount,status,description,reference)
        VALUES(t.user_id,'bonus',t.currency,gain,'completed',
          'Matured growth - '||COALESCE(t.cycle_label,'growth cycle'),
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
      v_checked_user := NULL;
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

CREATE OR REPLACE FUNCTION public.settle_due_tranches_for_user(p_user_id uuid)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_tranche public.deposit_tranches%ROWTYPE;
  v_gain numeric;
  v_settled integer := 0;
BEGIN
  FOR v_tranche IN
    SELECT * FROM public.deposit_tranches
    WHERE user_id=p_user_id AND status='locked' AND approved=true
      AND maturity_date<=now() AND remaining>0 AND current_balance>0
    ORDER BY maturity_date,created_at FOR UPDATE
  LOOP
    BEGIN
      v_gain := greatest(0,COALESCE(v_tranche.target_gain,
        COALESCE(v_tranche.current_balance,v_tranche.remaining)-v_tranche.remaining));
      INSERT INTO public.tranche_maturity_settlements(tranche_id,gain)
      VALUES(v_tranche.id,v_gain) ON CONFLICT DO NOTHING;
      IF NOT FOUND THEN CONTINUE; END IF;
      IF v_gain > 0 THEN
        UPDATE public.wallets SET balance=balance+v_gain,updated_at=now()
        WHERE user_id=p_user_id AND currency=v_tranche.currency;
        IF NOT FOUND THEN RAISE EXCEPTION 'Maturity wallet is missing for tranche %',v_tranche.id; END IF;
        INSERT INTO public.transactions(user_id,type,currency,amount,status,description,reference)
        VALUES(p_user_id,'bonus',v_tranche.currency,v_gain,'completed',
          'Matured growth - '||COALESCE(v_tranche.cycle_label,'growth cycle'),
          'MATURITY-'||v_tranche.id::text);
      END IF;
      UPDATE public.deposit_tranches SET status='matured',current_balance=remaining WHERE id=v_tranche.id;
      v_settled := v_settled+1;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'Skipped maturity for tranche %: %',v_tranche.id,SQLERRM;
    END;
  END LOOP;
  RETURN v_settled;
END;
$$;

REVOKE ALL ON FUNCTION public.submit_deposit_secure(numeric,text,text,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_approve_deposit_secure(uuid,numeric,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.move_withdrawable_to_growing_idempotent_secure(numeric,text,uuid,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.apply_daily_tranche_incentive() FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.settle_due_tranches_for_user(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.submit_deposit_secure(numeric,text,text,text,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_approve_deposit_secure(uuid,numeric,text,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.move_withdrawable_to_growing_idempotent_secure(numeric,text,uuid,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.settle_due_tranches_for_user(uuid) TO service_role;
