-- Registered payout details are used to help an administrator compare a
-- withdrawal request with the account supplied when the wallet was opened.
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS bank_name text,
  ADD COLUMN IF NOT EXISTS bank_account_number text;

CREATE OR REPLACE FUNCTION public.set_registered_payout_details(
  p_bank_name text,
  p_account_number text
)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_bank_name text := trim(COALESCE(p_bank_name, ''));
  v_account_number text := trim(COALESCE(p_account_number, ''));
BEGIN
  IF auth.uid() IS NULL
     OR length(v_bank_name) NOT BETWEEN 2 AND 100
     OR length(v_account_number) NOT BETWEEN 4 AND 40
     OR v_account_number !~ '^[0-9 -]+$' THEN
    RAISE EXCEPTION 'Invalid payout details';
  END IF;

  UPDATE public.profiles
  SET bank_name = v_bank_name,
      bank_account_number = v_account_number
  WHERE id = auth.uid();
END;
$$;

REVOKE ALL ON FUNCTION public.set_registered_payout_details(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_registered_payout_details(text, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE new_account_id TEXT;
BEGIN
  new_account_id := public.generate_account_id();
  INSERT INTO public.profiles (
    id, account_id, first_name, surname, email, phone, primary_currency,
    bank_name, bank_account_number
  ) VALUES (
    NEW.id, new_account_id,
    COALESCE(NEW.raw_user_meta_data->>'first_name', ''),
    COALESCE(NEW.raw_user_meta_data->>'surname', ''),
    COALESCE(NEW.email, ''),
    COALESCE(NEW.raw_user_meta_data->>'phone', ''),
    COALESCE(NEW.raw_user_meta_data->>'primary_currency', 'ZAR'),
    NULLIF(trim(COALESCE(NEW.raw_user_meta_data->>'bank_name', '')), ''),
    NULLIF(trim(COALESCE(NEW.raw_user_meta_data->>'bank_account_number', '')), '')
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

CREATE OR REPLACE FUNCTION public.request_withdrawal_secure(
  p_amount numeric,
  p_currency text,
  p_bank_name text DEFAULT NULL,
  p_account_number text DEFAULT NULL,
  p_confirm_break boolean DEFAULT false
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_wallet public.wallets%ROWTYPE;
  v_profile public.profiles%ROWTYPE;
  v_tranche public.deposit_tranches%ROWTYPE;
  v_locked numeric := 0;
  v_withdrawable numeric;
  v_remaining numeric;
  v_take numeric;
  v_penalty numeric;
  v_payout numeric;
  v_tx uuid;
BEGIN
  IF auth.uid() IS NULL OR p_currency NOT IN ('ZAR', 'USD') OR p_amount <= 0 OR p_amount > 10000000 THEN
    RAISE EXCEPTION 'Invalid withdrawal request';
  END IF;

  SELECT * INTO v_wallet FROM public.wallets
  WHERE user_id = auth.uid() AND currency = p_currency FOR UPDATE;
  IF NOT FOUND OR v_wallet.balance < p_amount THEN RAISE EXCEPTION 'Insufficient balance'; END IF;

  SELECT * INTO v_profile FROM public.profiles WHERE id = auth.uid();
  IF NOT FOUND OR v_profile.kyc_status <> 'verified' THEN
    RAISE EXCEPTION 'Identity review must be approved before withdrawal';
  END IF;
  IF length(trim(COALESCE(v_profile.bank_name, ''))) < 2
     OR length(trim(COALESCE(v_profile.bank_account_number, ''))) < 4 THEN
    RAISE EXCEPTION 'Add your registered payout details in Settings before withdrawing';
  END IF;
  IF length(trim(COALESCE(p_bank_name, ''))) < 2
     OR trim(COALESCE(p_account_number, '')) !~ '^[0-9 -]{4,40}$' THEN
    RAISE EXCEPTION 'Enter valid bank details for this withdrawal';
  END IF;

  FOR v_tranche IN SELECT * FROM public.deposit_tranches
    WHERE user_id = auth.uid() AND currency = p_currency AND status = 'locked'
      AND maturity_date > now() AND remaining > 0 FOR UPDATE LOOP
    v_locked := v_locked + v_tranche.remaining;
  END LOOP;
  v_withdrawable := v_wallet.balance - v_locked;
  IF p_amount > v_withdrawable AND NOT p_confirm_break THEN RAISE EXCEPTION 'BREAKS_TRANCHE'; END IF;

  v_remaining := p_amount;
  FOR v_tranche IN SELECT * FROM public.deposit_tranches
    WHERE user_id = auth.uid() AND currency = p_currency AND status IN ('locked', 'matured')
      AND remaining > 0 ORDER BY maturity_date, created_at FOR UPDATE LOOP
    EXIT WHEN v_remaining <= 0;
    v_take := least(v_tranche.current_balance, v_remaining);
    UPDATE public.deposit_tranches
    SET remaining = greatest(0, remaining - v_take),
        current_balance = greatest(0, current_balance - v_take),
        status = CASE WHEN remaining - v_take <= 0 THEN 'depleted' ELSE status END
    WHERE id = v_tranche.id;
    v_remaining := v_remaining - v_take;
  END LOOP;
  IF v_remaining > 0 THEN RAISE EXCEPTION 'Unable to allocate withdrawal'; END IF;

  v_penalty := CASE WHEN p_amount > v_withdrawable THEN round((p_amount - v_withdrawable) * 0.05, 2) ELSE 0 END;
  v_payout := round(p_amount - v_penalty, 2);
  INSERT INTO public.transactions (user_id, type, currency, amount, status, description)
  VALUES (
    auth.uid(), 'withdrawal', p_currency, v_payout, 'pending',
    'Withdrawal request — Bank: ' || left(trim(p_bank_name), 200) || ' · Acc: ' || left(trim(p_account_number), 100)
  ) RETURNING id INTO v_tx;
  IF v_penalty > 0 THEN
    INSERT INTO public.transactions (user_id, type, currency, amount, status, reference, description)
    VALUES (auth.uid(), 'fee', p_currency, v_penalty, 'completed', v_tx::text, 'Early withdrawal fee');
  END IF;
  UPDATE public.wallets SET balance = balance - p_amount, updated_at = now() WHERE id = v_wallet.id;
  RETURN jsonb_build_object('grossAmount', p_amount, 'penalty', v_penalty, 'payoutAmount', v_payout);
END;
$$;
