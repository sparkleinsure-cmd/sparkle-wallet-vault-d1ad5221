-- Release hardening: customer-facing roles may read their own financial data,
-- but every financial write is performed by a narrowly-scoped SECURITY DEFINER
-- function. This prevents direct REST/WebView writes to balances or ledgers.

REVOKE INSERT, UPDATE, DELETE ON public.wallets FROM authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.transactions FROM authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.deposit_tranches FROM authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.profiles FROM authenticated;

DROP POLICY IF EXISTS "own wallets update" ON public.wallets;
DROP POLICY IF EXISTS "own tx insert" ON public.transactions;
DROP POLICY IF EXISTS "own tranches insert" ON public.deposit_tranches;
DROP POLICY IF EXISTS "own tranches update" ON public.deposit_tranches;
DROP POLICY IF EXISTS "own profile update" ON public.profiles;
DROP POLICY IF EXISTS "own profile insert" ON public.profiles;

CREATE UNIQUE INDEX IF NOT EXISTS transactions_user_reference_unique
  ON public.transactions (user_id, reference)
  WHERE reference IS NOT NULL;

-- Only the named operating account receives administrator access automatically.
DELETE FROM public.user_roles ur
USING auth.users u
WHERE ur.user_id = u.id
  AND ur.role = 'admin'::public.app_role
  AND lower(u.email) <> 'sparkleinsure@gmail.com';

INSERT INTO public.user_roles (user_id, role)
SELECT id, 'admin'::public.app_role
FROM auth.users
WHERE lower(email) = 'sparkleinsure@gmail.com'
ON CONFLICT DO NOTHING;

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE new_account_id TEXT;
BEGIN
  new_account_id := public.generate_account_id();
  INSERT INTO public.profiles (id, account_id, first_name, surname, email, phone, primary_currency)
  VALUES (
    NEW.id, new_account_id,
    COALESCE(NEW.raw_user_meta_data->>'first_name', ''),
    COALESCE(NEW.raw_user_meta_data->>'surname', ''),
    COALESCE(NEW.email, ''),
    COALESCE(NEW.raw_user_meta_data->>'phone', ''),
    COALESCE(NEW.raw_user_meta_data->>'primary_currency', 'ZAR')
  );
  INSERT INTO public.wallets (user_id, currency, balance) VALUES
    (NEW.id, 'ZAR', 0), (NEW.id, 'NGN', 0), (NEW.id, 'GHS', 0), (NEW.id, 'USD', 0);
  INSERT INTO public.user_roles (user_id, role) VALUES (NEW.id, 'user');
  IF lower(COALESCE(NEW.email, '')) = 'sparkleinsure@gmail.com' THEN
    INSERT INTO public.user_roles (user_id, role) VALUES (NEW.id, 'admin') ON CONFLICT DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.grant_admin_on_verify()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.email_confirmed_at IS NOT NULL AND lower(COALESCE(NEW.email, '')) = 'sparkleinsure@gmail.com' THEN
    INSERT INTO public.user_roles (user_id, role) VALUES (NEW.id, 'admin') ON CONFLICT DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.set_primary_currency_secure(p_currency text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF auth.uid() IS NULL OR p_currency NOT IN ('ZAR', 'USD') THEN RAISE EXCEPTION 'Invalid request'; END IF;
  UPDATE public.profiles SET primary_currency = p_currency WHERE id = auth.uid();
END;
$$;

CREATE OR REPLACE FUNCTION public.submit_kyc_review(p_proof_path text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF auth.uid() IS NULL OR length(trim(COALESCE(p_proof_path, ''))) < 3 THEN RAISE EXCEPTION 'Invalid verification submission'; END IF;
  IF split_part(p_proof_path, '/', 1) <> auth.uid()::text THEN RAISE EXCEPTION 'Invalid verification file'; END IF;
  UPDATE public.profiles SET proof_url = p_proof_path, kyc_status = 'pending' WHERE id = auth.uid();
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_set_kyc_status(p_user_id uuid, p_status public.kyc_status)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(), 'admin'::public.app_role) THEN RAISE EXCEPTION 'Forbidden'; END IF;
  IF p_status NOT IN ('verified'::public.kyc_status, 'rejected'::public.kyc_status) THEN RAISE EXCEPTION 'Invalid status'; END IF;
  UPDATE public.profiles SET kyc_status = p_status WHERE id = p_user_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.submit_deposit_secure(p_amount numeric, p_currency text, p_reference text, p_proof_path text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_tx uuid;
BEGIN
  IF auth.uid() IS NULL OR p_currency NOT IN ('ZAR', 'USD') OR p_amount <= 0 OR p_amount > 10000000
     OR length(trim(COALESCE(p_reference, ''))) NOT BETWEEN 3 AND 200
     OR split_part(COALESCE(p_proof_path, ''), '/', 1) <> auth.uid()::text THEN
    RAISE EXCEPTION 'Invalid deposit request';
  END IF;
  INSERT INTO public.transactions (user_id, type, currency, amount, status, reference, description, proof_url)
  VALUES (auth.uid(), 'deposit', p_currency, round(p_amount, 2), 'pending', trim(p_reference), 'Deposit submitted — awaiting administrator review', p_proof_path)
  RETURNING id INTO v_tx;
  RETURN v_tx;
EXCEPTION WHEN unique_violation THEN
  RAISE EXCEPTION 'A deposit with this reference has already been submitted';
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_approve_deposit_secure(p_tx_id uuid, p_corrected_amount numeric DEFAULT NULL, p_note text DEFAULT NULL)
RETURNS numeric LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_tx public.transactions%ROWTYPE; v_amount numeric;
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(), 'admin'::public.app_role) THEN RAISE EXCEPTION 'Forbidden'; END IF;
  SELECT * INTO v_tx FROM public.transactions WHERE id = p_tx_id FOR UPDATE;
  IF NOT FOUND OR v_tx.type <> 'deposit' OR v_tx.status <> 'pending' THEN RAISE EXCEPTION 'Deposit not found or already processed'; END IF;
  v_amount := COALESCE(p_corrected_amount, v_tx.amount);
  IF v_amount <= 0 OR v_amount > 10000000 THEN RAISE EXCEPTION 'Invalid amount'; END IF;
  UPDATE public.transactions SET amount = round(v_amount, 2), status = 'completed', description = 'Deposit approved by administrator' || CASE WHEN length(trim(COALESCE(p_note,''))) > 0 THEN ' — ' || left(trim(p_note), 300) ELSE '' END WHERE id = v_tx.id;
  UPDATE public.wallets SET balance = balance + round(v_amount, 2), updated_at = now() WHERE user_id = v_tx.user_id AND currency = v_tx.currency;
  INSERT INTO public.deposit_tranches (user_id, currency, amount, remaining, current_balance, status, source, transaction_id, maturity_date, approved)
  VALUES (v_tx.user_id, v_tx.currency, round(v_amount, 2), round(v_amount, 2), round(v_amount, 2), 'locked', 'deposit', v_tx.id, now() + interval '30 days', true);
  RETURN round(v_amount, 2);
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_decline_deposit_secure(p_tx_id uuid, p_reason text DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_tx public.transactions%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(), 'admin'::public.app_role) THEN RAISE EXCEPTION 'Forbidden'; END IF;
  SELECT * INTO v_tx FROM public.transactions WHERE id = p_tx_id FOR UPDATE;
  IF NOT FOUND OR v_tx.type <> 'deposit' OR v_tx.status <> 'pending' THEN RAISE EXCEPTION 'Deposit not found or already processed'; END IF;
  UPDATE public.transactions SET status = 'declined', description = 'Deposit declined by administrator' || CASE WHEN length(trim(COALESCE(p_reason,''))) > 0 THEN ' — ' || left(trim(p_reason), 300) ELSE '' END WHERE id = v_tx.id;
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_complete_withdrawal_secure(p_tx_id uuid, p_note text DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_tx public.transactions%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(), 'admin'::public.app_role) THEN RAISE EXCEPTION 'Forbidden'; END IF;
  SELECT * INTO v_tx FROM public.transactions WHERE id = p_tx_id FOR UPDATE;
  IF NOT FOUND OR v_tx.type <> 'withdrawal' OR v_tx.status <> 'pending' THEN RAISE EXCEPTION 'Withdrawal not found or already processed'; END IF;
  UPDATE public.transactions
  SET status = 'completed', description = 'Withdrawal approved — paid' || CASE WHEN length(trim(COALESCE(p_note,''))) > 0 THEN ' — ' || left(trim(p_note), 300) ELSE '' END
  WHERE id = v_tx.id;
END;
$$;

CREATE OR REPLACE FUNCTION public.request_withdrawal_secure(p_amount numeric, p_currency text, p_bank_name text DEFAULT NULL, p_account_number text DEFAULT NULL, p_confirm_break boolean DEFAULT false)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_wallet public.wallets%ROWTYPE; v_profile public.profiles%ROWTYPE; v_tranche public.deposit_tranches%ROWTYPE;
  v_locked numeric := 0; v_withdrawable numeric; v_remaining numeric; v_take numeric; v_penalty numeric; v_payout numeric; v_tx uuid;
BEGIN
  IF auth.uid() IS NULL OR p_currency NOT IN ('ZAR','USD') OR p_amount <= 0 OR p_amount > 10000000 THEN RAISE EXCEPTION 'Invalid withdrawal request'; END IF;
  SELECT * INTO v_wallet FROM public.wallets WHERE user_id = auth.uid() AND currency = p_currency FOR UPDATE;
  IF NOT FOUND OR v_wallet.balance < p_amount THEN RAISE EXCEPTION 'Insufficient balance'; END IF;
  SELECT * INTO v_profile FROM public.profiles WHERE id = auth.uid();
  IF NOT FOUND OR v_profile.kyc_status <> 'verified' THEN RAISE EXCEPTION 'Identity review must be approved before withdrawal'; END IF;
  v_locked := 0;
  FOR v_tranche IN SELECT * FROM public.deposit_tranches WHERE user_id = auth.uid() AND currency = p_currency AND status = 'locked' AND maturity_date > now() AND remaining > 0 FOR UPDATE LOOP
    v_locked := v_locked + v_tranche.remaining;
  END LOOP;
  v_withdrawable := v_wallet.balance - v_locked;
  IF p_amount > v_withdrawable AND NOT p_confirm_break THEN RAISE EXCEPTION 'BREAKS_TRANCHE'; END IF;
  v_remaining := p_amount;
  FOR v_tranche IN SELECT * FROM public.deposit_tranches WHERE user_id = auth.uid() AND currency = p_currency AND status IN ('locked','matured') AND remaining > 0 ORDER BY maturity_date, created_at FOR UPDATE LOOP
    EXIT WHEN v_remaining <= 0;
    IF v_tranche.status = 'locked' AND v_tranche.maturity_date > now() AND NOT p_confirm_break THEN CONTINUE; END IF;
    v_take := LEAST(COALESCE(v_tranche.current_balance, v_tranche.remaining), v_remaining);
    IF v_take <= 0 THEN CONTINUE; END IF;
    UPDATE public.deposit_tranches SET
      remaining = GREATEST(0, remaining - LEAST(remaining, round(remaining * (v_take / NULLIF(current_balance, 0)), 2))),
      current_balance = GREATEST(0, current_balance - v_take),
      status = CASE WHEN current_balance - v_take <= 0 THEN 'liquidated' ELSE status END
    WHERE id = v_tranche.id;
    v_remaining := v_remaining - v_take;
  END LOOP;
  IF v_remaining > 0 THEN RAISE EXCEPTION 'Unable to allocate withdrawal'; END IF;
  v_penalty := CASE WHEN p_amount > v_withdrawable THEN round((p_amount - v_withdrawable) * 0.05, 2) ELSE 0 END;
  v_payout := round(p_amount - v_penalty, 2);
  INSERT INTO public.transactions (user_id, type, currency, amount, status, description)
  VALUES (auth.uid(), 'withdrawal', p_currency, v_payout, 'pending', 'Withdrawal request — Bank: ' || left(COALESCE(p_bank_name,'n/a'), 200) || ' · Acc: ' || left(COALESCE(p_account_number,'n/a'), 100)) RETURNING id INTO v_tx;
  IF v_penalty > 0 THEN INSERT INTO public.transactions (user_id, type, currency, amount, status, reference, description) VALUES (auth.uid(), 'fee', p_currency, v_penalty, 'completed', v_tx::text, 'Early withdrawal fee'); END IF;
  UPDATE public.wallets SET balance = balance - p_amount, updated_at = now() WHERE id = v_wallet.id;
  RETURN jsonb_build_object('grossAmount', p_amount, 'penalty', v_penalty, 'payoutAmount', v_payout);
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_credit_bonus_secure(p_user_id uuid, p_currency text, p_amount numeric, p_note text DEFAULT NULL, p_hold_rule text DEFAULT 'instant', p_parent_tranche_id uuid DEFAULT NULL)
RETURNS numeric LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_maturity timestamptz := now(); v_parent uuid := NULL; v_balance numeric;
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(), 'admin'::public.app_role) THEN RAISE EXCEPTION 'Forbidden'; END IF;
  IF p_currency NOT IN ('ZAR','USD') OR p_amount <= 0 OR p_amount > 1000000 OR p_hold_rule NOT IN ('attach','instant') THEN RAISE EXCEPTION 'Invalid credit'; END IF;
  IF p_hold_rule = 'attach' THEN
    SELECT maturity_date, id INTO v_maturity, v_parent FROM public.deposit_tranches WHERE id = p_parent_tranche_id AND user_id = p_user_id AND status = 'locked' AND remaining > 0 FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Active tranche not found'; END IF;
  END IF;
  UPDATE public.wallets SET balance = balance + round(p_amount,2), updated_at = now() WHERE user_id = p_user_id AND currency = p_currency RETURNING balance INTO v_balance;
  INSERT INTO public.transactions (user_id,type,currency,amount,status,description) VALUES (p_user_id,'bonus',p_currency,round(p_amount,2),'completed',COALESCE(NULLIF(left(trim(COALESCE(p_note,'')),200),''),'Administrator credit'));
  INSERT INTO public.deposit_tranches (user_id,currency,amount,remaining,current_balance,status,source,parent_tranche_id,maturity_date,approved)
  VALUES (p_user_id,p_currency,round(p_amount,2),round(p_amount,2),round(p_amount,2),CASE WHEN p_hold_rule='instant' THEN 'matured' ELSE 'locked' END,'bonus',v_parent,v_maturity,true);
  RETURN v_balance;
END;
$$;

REVOKE ALL ON FUNCTION public.set_primary_currency_secure(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.submit_kyc_review(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_set_kyc_status(uuid, public.kyc_status) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.submit_deposit_secure(numeric,text,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_approve_deposit_secure(uuid,numeric,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_decline_deposit_secure(uuid,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_complete_withdrawal_secure(uuid,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.request_withdrawal_secure(numeric,text,text,text,boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_credit_bonus_secure(uuid,text,numeric,text,text,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_primary_currency_secure(text), public.submit_kyc_review(text), public.admin_set_kyc_status(uuid, public.kyc_status), public.submit_deposit_secure(numeric,text,text,text), public.admin_approve_deposit_secure(uuid,numeric,text), public.admin_decline_deposit_secure(uuid,text), public.admin_complete_withdrawal_secure(uuid,text), public.request_withdrawal_secure(numeric,text,text,text,boolean), public.admin_credit_bonus_secure(uuid,text,numeric,text,text,uuid) TO authenticated;
