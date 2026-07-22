-- Welcome-bonus verification, a seven-day payout-detail change delay, and
-- server-side use of registered payout details for withdrawals.
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS bank_details_change_requested_at timestamptz,
  ADD COLUMN IF NOT EXISTS welcome_bonus_credited_at timestamptz;

CREATE OR REPLACE FUNCTION public.submit_kyc_review(p_proof_path text, p_selfie_path text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF auth.uid() IS NULL OR length(trim(COALESCE(p_selfie_path,''))) < 3
     OR split_part(p_selfie_path,'/',1) <> auth.uid()::text
     OR (p_proof_path IS NOT NULL AND split_part(p_proof_path,'/',1) <> auth.uid()::text) THEN
    RAISE EXCEPTION 'Invalid verification submission';
  END IF;
  UPDATE public.profiles SET proof_url=COALESCE(p_proof_path,proof_url), selfie_url=p_selfie_path,
    kyc_status='pending' WHERE id=auth.uid();
END;
$$;

CREATE OR REPLACE FUNCTION public.request_payout_details_change()
RETURNS timestamptz LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_available_at timestamptz;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Unauthorized'; END IF;
  UPDATE public.profiles
  SET bank_details_change_requested_at = COALESCE(bank_details_change_requested_at, now())
  WHERE id = auth.uid()
  RETURNING bank_details_change_requested_at + interval '7 days' INTO v_available_at;
  RETURN v_available_at;
END;
$$;

CREATE OR REPLACE FUNCTION public.set_registered_payout_details(p_bank_name text, p_account_number text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_bank_name text := trim(COALESCE(p_bank_name, ''));
  v_account_number text := regexp_replace(trim(COALESCE(p_account_number, '')), '[ -]', '', 'g');
  v_profile public.profiles%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL OR length(v_bank_name) NOT BETWEEN 2 AND 100
     OR length(v_account_number) NOT BETWEEN 4 AND 40 OR v_account_number !~ '^[0-9]+$' THEN
    RAISE EXCEPTION 'Invalid payout details';
  END IF;
  SELECT * INTO v_profile FROM public.profiles WHERE id = auth.uid() FOR UPDATE;
  IF v_profile.bank_account_number IS NOT NULL AND
     (v_profile.bank_details_change_requested_at IS NULL OR
      v_profile.bank_details_change_requested_at + interval '7 days' > now()) THEN
    RAISE EXCEPTION 'Bank details are locked. Request a change and wait 7 days.';
  END IF;
  UPDATE public.profiles SET bank_name = v_bank_name, bank_account_number = v_account_number,
    bank_details_change_requested_at = NULL WHERE id = auth.uid();
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_set_kyc_status(p_user_id uuid, p_status public.kyc_status)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_tx uuid;
BEGIN
  IF NOT public.has_role(auth.uid(), 'admin') THEN RAISE EXCEPTION 'Forbidden'; END IF;
  IF p_status NOT IN ('verified'::public.kyc_status, 'rejected'::public.kyc_status) THEN RAISE EXCEPTION 'Invalid status'; END IF;

  UPDATE public.profiles SET kyc_status = p_status WHERE id = p_user_id;

  -- One atomic, idempotent R10 award. The bonus starts a 30-day growing cycle.
  IF p_status = 'verified' AND EXISTS (
      SELECT 1 FROM public.profiles WHERE id = p_user_id
        AND selfie_url IS NOT NULL AND bank_name IS NOT NULL
        AND bank_account_number IS NOT NULL AND welcome_bonus_credited_at IS NULL
    ) THEN
    UPDATE public.wallets SET balance = balance + 10, updated_at = now()
      WHERE user_id = p_user_id AND currency = 'ZAR';
    INSERT INTO public.transactions(user_id, type, currency, amount, status, description, reference)
      VALUES (p_user_id, 'bonus', 'ZAR', 10, 'completed', 'R10 welcome bonus', 'WELCOME-' || p_user_id::text)
      RETURNING id INTO v_tx;
    INSERT INTO public.deposit_tranches(user_id, currency, amount, remaining, current_balance,
      status, source, transaction_id, maturity_date, approved, note)
      VALUES (p_user_id, 'ZAR', 10, 10, 10, 'locked', 'bonus', v_tx,
        now() + interval '30 days', true, 'R10 welcome bonus');
    UPDATE public.profiles SET welcome_bonus_credited_at = now() WHERE id = p_user_id;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.request_withdrawal_secure(
  p_amount numeric, p_currency text, p_bank_name text DEFAULT NULL,
  p_account_number text DEFAULT NULL, p_confirm_break boolean DEFAULT false
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_wallet public.wallets%ROWTYPE; v_profile public.profiles%ROWTYPE;
  v_tranche public.deposit_tranches%ROWTYPE; v_locked numeric := 0;
  v_withdrawable numeric; v_remaining numeric; v_take numeric;
  v_penalty numeric; v_payout numeric; v_tx uuid;
BEGIN
  IF auth.uid() IS NULL OR p_currency NOT IN ('ZAR','USD') OR p_amount <= 0 OR p_amount > 10000000 THEN RAISE EXCEPTION 'Invalid withdrawal request'; END IF;
  SELECT * INTO v_wallet FROM public.wallets WHERE user_id=auth.uid() AND currency=p_currency FOR UPDATE;
  IF NOT FOUND OR v_wallet.balance < p_amount THEN RAISE EXCEPTION 'Insufficient balance'; END IF;
  SELECT * INTO v_profile FROM public.profiles WHERE id=auth.uid();
  IF NOT FOUND OR v_profile.kyc_status <> 'verified' THEN RAISE EXCEPTION 'Identity review must be approved before withdrawal'; END IF;
  IF length(trim(COALESCE(v_profile.bank_name,''))) < 2 OR trim(COALESCE(v_profile.bank_account_number,'')) !~ '^[0-9]{4,40}$' THEN RAISE EXCEPTION 'Add your registered payout details in Settings before withdrawing'; END IF;
  FOR v_tranche IN SELECT * FROM public.deposit_tranches WHERE user_id=auth.uid() AND currency=p_currency AND status='locked' AND maturity_date>now() AND remaining>0 FOR UPDATE LOOP v_locked := v_locked + v_tranche.remaining; END LOOP;
  v_withdrawable := v_wallet.balance-v_locked;
  IF p_amount>v_withdrawable AND NOT p_confirm_break THEN RAISE EXCEPTION 'BREAKS_TRANCHE'; END IF;
  v_remaining:=p_amount;
  FOR v_tranche IN SELECT * FROM public.deposit_tranches WHERE user_id=auth.uid() AND currency=p_currency AND status IN ('locked','matured') AND remaining>0 ORDER BY maturity_date,created_at FOR UPDATE LOOP
    EXIT WHEN v_remaining<=0; v_take:=least(v_tranche.current_balance,v_remaining);
    UPDATE public.deposit_tranches SET remaining=greatest(0,remaining-v_take), current_balance=greatest(0,current_balance-v_take), status=CASE WHEN remaining-v_take<=0 THEN 'depleted' ELSE status END WHERE id=v_tranche.id;
    v_remaining:=v_remaining-v_take;
  END LOOP;
  IF v_remaining>0 THEN RAISE EXCEPTION 'Unable to allocate withdrawal'; END IF;
  v_penalty:=CASE WHEN p_amount>v_withdrawable THEN round((p_amount-v_withdrawable)*0.05,2) ELSE 0 END; v_payout:=round(p_amount-v_penalty,2);
  INSERT INTO public.transactions(user_id,type,currency,amount,status,description) VALUES(auth.uid(),'withdrawal',p_currency,v_payout,'pending','Withdrawal request - '||v_profile.bank_name||' account ending '||right(v_profile.bank_account_number,4)) RETURNING id INTO v_tx;
  IF v_penalty>0 THEN INSERT INTO public.transactions(user_id,type,currency,amount,status,reference,description) VALUES(auth.uid(),'fee',p_currency,v_penalty,'completed',v_tx::text,'Early withdrawal fee'); END IF;
  UPDATE public.wallets SET balance=balance-p_amount,updated_at=now() WHERE id=v_wallet.id;
  RETURN jsonb_build_object('grossAmount',p_amount,'penalty',v_penalty,'payoutAmount',v_payout,'accountLast4',right(v_profile.bank_account_number,4));
END;
$$;

REVOKE ALL ON FUNCTION public.request_payout_details_change() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.request_payout_details_change() TO authenticated;
