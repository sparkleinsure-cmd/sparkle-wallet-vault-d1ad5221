-- Reject invalid money states at the database boundary. NOT VALID preserves
-- any legacy rows for reconciliation while enforcing the rules on new writes.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'wallets_balance_nonnegative') THEN
    ALTER TABLE public.wallets
      ADD CONSTRAINT wallets_balance_nonnegative CHECK (balance >= 0) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'transactions_amount_positive') THEN
    ALTER TABLE public.transactions
      ADD CONSTRAINT transactions_amount_positive CHECK (amount > 0) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'deposit_tranches_amount_positive') THEN
    ALTER TABLE public.deposit_tranches
      ADD CONSTRAINT deposit_tranches_amount_positive CHECK (amount > 0) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'deposit_tranches_balances_nonnegative') THEN
    ALTER TABLE public.deposit_tranches
      ADD CONSTRAINT deposit_tranches_balances_nonnegative
      CHECK (remaining >= 0 AND current_balance >= 0) NOT VALID;
  END IF;
END;
$$;

-- Normalize deposits to cents before validating them. The reference uniqueness
-- constraint makes a retry return a clear duplicate instead of creating a
-- second pending deposit.
CREATE OR REPLACE FUNCTION public.submit_deposit_secure(
  p_amount numeric, p_currency text, p_reference text, p_proof_path text
)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_tx uuid;
  v_amount numeric := round(p_amount, 2);
BEGIN
  IF auth.uid() IS NULL
     OR p_currency NOT IN ('ZAR', 'USD')
     OR v_amount < 0.01 OR v_amount > 10000000
     OR length(trim(COALESCE(p_reference, ''))) NOT BETWEEN 3 AND 200
     OR split_part(COALESCE(p_proof_path, ''), '/', 1) <> auth.uid()::text THEN
    RAISE EXCEPTION 'Invalid deposit request';
  END IF;

  INSERT INTO public.transactions (
    user_id, type, currency, amount, status, reference, description, proof_url
  ) VALUES (
    auth.uid(), 'deposit', p_currency, v_amount, 'pending', trim(p_reference),
    'Deposit submitted - awaiting administrator review', p_proof_path
  ) RETURNING id INTO v_tx;
  RETURN v_tx;
EXCEPTION WHEN unique_violation THEN
  RAISE EXCEPTION 'A deposit with this reference has already been submitted';
END;
$$;

-- Deposit approval is serialized by the pending transaction row. Missing
-- wallets now abort the entire approval instead of creating an unmatched
-- tranche or ledger entry.
CREATE OR REPLACE FUNCTION public.admin_approve_deposit_secure(
  p_tx_id uuid, p_corrected_amount numeric DEFAULT NULL, p_note text DEFAULT NULL
)
RETURNS numeric LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_tx public.transactions%ROWTYPE;
  v_amount numeric;
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

  v_amount := round(COALESCE(p_corrected_amount, v_tx.amount), 2);
  IF v_amount < 0.01 OR v_amount > 10000000 THEN RAISE EXCEPTION 'Invalid amount'; END IF;

  UPDATE public.wallets
  SET balance = balance + v_amount, updated_at = now()
  WHERE user_id = v_tx.user_id AND currency = v_tx.currency;
  IF NOT FOUND THEN RAISE EXCEPTION 'Deposit wallet not found'; END IF;

  UPDATE public.transactions
  SET amount = v_amount,
      status = 'completed',
      description = 'Deposit verified by admin' || CASE
        WHEN length(trim(COALESCE(p_note, ''))) > 0 THEN ' - ' || left(trim(p_note), 300)
        ELSE ''
      END
  WHERE id = v_tx.id;

  INSERT INTO public.deposit_tranches (
    user_id, currency, amount, remaining, current_balance, status, source,
    transaction_id, maturity_date, approved
  ) VALUES (
    v_tx.user_id, v_tx.currency, v_amount, v_amount, v_amount, 'locked',
    'deposit', v_tx.id, now() + interval '30 days', true
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
      UPDATE public.wallets
      SET balance = balance + v_reward, updated_at = now()
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
        'matured', 'referral', v_reward_tx_id, now(), true,
        'Immediately withdrawable referral reward'
      );

      UPDATE public.referrals
      SET first_deposit_transaction_id = v_tx.id,
          first_deposit_amount = v_amount,
          reward_amount = v_reward,
          reward_currency = v_tx.currency,
          rewarded_at = now()
      WHERE id = v_referral.id;
    END IF;
  END IF;

  RETURN v_amount;
END;
$$;

-- Every app withdrawal carries a UUID generated before the request is sent.
-- Reusing it after a timeout returns the original request and never debits the
-- wallet twice. All due cycles are settled before available funds are tested.
CREATE OR REPLACE FUNCTION public.request_withdrawal_idempotent_secure(
  p_amount numeric, p_currency text, p_request_id uuid
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_amount numeric := round(p_amount, 2);
  v_reference text := 'WITHDRAWAL-' || p_request_id::text;
  v_wallet public.wallets%ROWTYPE;
  v_profile public.profiles%ROWTYPE;
  v_existing public.transactions%ROWTYPE;
  v_tranche public.deposit_tranches%ROWTYPE;
  v_locked numeric := 0;
  v_withdrawable numeric;
  v_remaining numeric;
  v_take numeric;
  v_tx uuid;
BEGIN
  IF auth.uid() IS NULL OR p_currency NOT IN ('ZAR', 'USD')
     OR v_amount < 0.01 OR v_amount > 10000000 THEN
    RAISE EXCEPTION 'Invalid withdrawal request';
  END IF;

  SELECT * INTO v_profile FROM public.profiles WHERE id = auth.uid();
  IF NOT FOUND OR v_profile.kyc_status <> 'verified' THEN
    RAISE EXCEPTION 'Identity review must be approved before withdrawal';
  END IF;
  IF COALESCE(v_profile.account_frozen, false) THEN
    RAISE EXCEPTION 'Your account is frozen while a compliance review is in progress';
  END IF;
  IF length(trim(COALESCE(v_profile.bank_name, ''))) < 2
     OR trim(COALESCE(v_profile.bank_account_number, '')) !~ '^[0-9]{4,40}$' THEN
    RAISE EXCEPTION 'Add your registered payout details in Settings before withdrawing';
  END IF;

  PERFORM public.settle_due_tranches_for_user(auth.uid());

  SELECT * INTO v_wallet FROM public.wallets
  WHERE user_id = auth.uid() AND currency = p_currency FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Wallet not found'; END IF;

  SELECT * INTO v_existing FROM public.transactions
  WHERE user_id = auth.uid() AND reference = v_reference;
  IF FOUND THEN
    IF v_existing.type <> 'withdrawal' OR v_existing.currency <> p_currency
       OR v_existing.amount <> v_amount THEN
      RAISE EXCEPTION 'This request identifier was already used for different details';
    END IF;
    IF v_existing.status = 'failed' THEN
      RAISE EXCEPTION 'This withdrawal was refunded; submit a new request';
    END IF;
    RETURN jsonb_build_object(
      'grossAmount', v_amount, 'penalty', 0, 'payoutAmount', v_amount,
      'accountLast4', right(v_profile.bank_account_number, 4),
      'withdrawalId', v_existing.id, 'replayed', true
    );
  END IF;

  SELECT COALESCE(sum(remaining), 0) INTO v_locked
  FROM public.deposit_tranches
  WHERE user_id = auth.uid() AND currency = p_currency
    AND status = 'locked' AND remaining > 0;

  v_withdrawable := greatest(0, v_wallet.balance - v_locked);
  IF v_amount > v_withdrawable THEN
    RAISE EXCEPTION 'Only matured funds are withdrawable. Locked 30-day cycles cannot be withdrawn early.';
  END IF;

  v_remaining := v_amount;
  FOR v_tranche IN
    SELECT * FROM public.deposit_tranches
    WHERE user_id = auth.uid() AND currency = p_currency
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

  INSERT INTO public.transactions (
    user_id, type, currency, amount, status, description, reference
  ) VALUES (
    auth.uid(), 'withdrawal', p_currency, v_amount, 'pending',
    'Withdrawal request - ' || v_profile.bank_name || ' account ending ' || right(v_profile.bank_account_number, 4),
    v_reference
  ) RETURNING id INTO v_tx;

  UPDATE public.wallets SET balance = balance - v_amount, updated_at = now()
  WHERE id = v_wallet.id;

  RETURN jsonb_build_object(
    'grossAmount', v_amount, 'penalty', 0, 'payoutAmount', v_amount,
    'accountLast4', right(v_profile.bank_account_number, 4),
    'withdrawalId', v_tx, 'replayed', false
  );
END;
$$;

-- A failed bank payout reverses the reservation exactly once under locks.
CREATE OR REPLACE FUNCTION public.admin_refund_withdrawal_secure(
  p_tx_id uuid, p_note text DEFAULT NULL
)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_tx public.transactions%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(), 'admin'::public.app_role) THEN
    RAISE EXCEPTION 'Forbidden';
  END IF;

  SELECT * INTO v_tx FROM public.transactions WHERE id = p_tx_id FOR UPDATE;
  IF NOT FOUND OR v_tx.type <> 'withdrawal' OR v_tx.status <> 'pending' THEN
    RAISE EXCEPTION 'Withdrawal not found or already processed';
  END IF;

  UPDATE public.wallets
  SET balance = balance + v_tx.amount, updated_at = now()
  WHERE user_id = v_tx.user_id AND currency = v_tx.currency;
  IF NOT FOUND THEN RAISE EXCEPTION 'Withdrawal wallet not found'; END IF;

  UPDATE public.transactions
  SET status = 'failed',
      description = 'Withdrawal failed - funds returned to wallet' || CASE
        WHEN length(trim(COALESCE(p_note, ''))) > 0 THEN ' - ' || left(trim(p_note), 300)
        ELSE ''
      END
  WHERE id = v_tx.id;
END;
$$;

-- Moving liquid funds into a growing cycle is also retry-safe. This changes
-- only the locked/withdrawable representation; total wallet value is unchanged.
CREATE OR REPLACE FUNCTION public.move_withdrawable_to_growing_idempotent_secure(
  p_amount numeric, p_currency text, p_request_id uuid
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_amount numeric := round(p_amount, 2);
  v_reference text := 'GROW-' || p_request_id::text;
  v_wallet public.wallets%ROWTYPE;
  v_profile public.profiles%ROWTYPE;
  v_existing public.transactions%ROWTYPE;
  v_tranche public.deposit_tranches%ROWTYPE;
  v_locked numeric := 0;
  v_withdrawable numeric;
  v_remaining numeric;
  v_take numeric;
  v_tx uuid;
  v_maturity timestamptz;
BEGIN
  IF auth.uid() IS NULL OR p_currency NOT IN ('ZAR', 'USD')
     OR v_amount < 0.01 OR v_amount > 10000000 THEN
    RAISE EXCEPTION 'Invalid transfer request';
  END IF;

  SELECT * INTO v_profile FROM public.profiles WHERE id = auth.uid();
  IF NOT FOUND THEN RAISE EXCEPTION 'Profile not found'; END IF;
  IF COALESCE(v_profile.account_frozen, false) THEN
    RAISE EXCEPTION 'Your account is frozen while a compliance review is in progress';
  END IF;

  PERFORM public.settle_due_tranches_for_user(auth.uid());

  SELECT * INTO v_wallet FROM public.wallets
  WHERE user_id = auth.uid() AND currency = p_currency FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Wallet not found'; END IF;

  SELECT * INTO v_existing FROM public.transactions
  WHERE user_id = auth.uid() AND reference = v_reference;
  IF FOUND THEN
    IF v_existing.type <> 'transfer' OR v_existing.currency <> p_currency
       OR v_existing.amount <> v_amount THEN
      RAISE EXCEPTION 'This request identifier was already used for different details';
    END IF;
    SELECT maturity_date INTO v_maturity FROM public.deposit_tranches
    WHERE transaction_id = v_existing.id ORDER BY created_at LIMIT 1;
    IF NOT FOUND THEN RAISE EXCEPTION 'Existing growing cycle record is incomplete'; END IF;
    RETURN jsonb_build_object(
      'ok', true, 'amount', v_amount, 'currency', p_currency,
      'maturityDate', v_maturity, 'transactionId', v_existing.id, 'replayed', true
    );
  END IF;

  SELECT COALESCE(sum(remaining), 0) INTO v_locked
  FROM public.deposit_tranches
  WHERE user_id = auth.uid() AND currency = p_currency
    AND status = 'locked' AND remaining > 0;
  v_withdrawable := greatest(0, v_wallet.balance - v_locked);
  IF v_amount > v_withdrawable THEN
    RAISE EXCEPTION 'Only withdrawable funds can be moved to growing';
  END IF;

  v_remaining := v_amount;
  FOR v_tranche IN
    SELECT * FROM public.deposit_tranches
    WHERE user_id = auth.uid() AND currency = p_currency
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

  v_maturity := now() + interval '30 days';
  INSERT INTO public.transactions (
    user_id, type, currency, amount, status, description, reference
  ) VALUES (
    auth.uid(), 'transfer', p_currency, v_amount, 'completed',
    'Moved from withdrawable to growing balance - new 30-day cycle', v_reference
  ) RETURNING id INTO v_tx;

  INSERT INTO public.deposit_tranches (
    user_id, currency, amount, remaining, current_balance, status, source,
    transaction_id, maturity_date, approved, note
  ) VALUES (
    auth.uid(), p_currency, v_amount, v_amount, v_amount, 'locked', 'transfer',
    v_tx, v_maturity, true, 'Moved from withdrawable balance'
  );

  RETURN jsonb_build_object(
    'ok', true, 'amount', v_amount, 'currency', p_currency,
    'maturityDate', v_maturity, 'transactionId', v_tx, 'replayed', false
  );
END;
$$;

-- Retry-safe administrator credits use the same request UUID principle as
-- withdrawals. The transaction reference is the permanent idempotency key.
CREATE OR REPLACE FUNCTION public.admin_credit_bonus_idempotent_secure(
  p_user_id uuid, p_currency text, p_amount numeric, p_note text,
  p_hold_rule text, p_parent_tranche_id uuid, p_request_id uuid
)
RETURNS numeric LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_amount numeric := round(p_amount, 2);
  v_reference text := 'ADMIN-CREDIT-' || p_request_id::text;
  v_maturity timestamptz := now();
  v_parent uuid := NULL;
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
    SELECT maturity_date, id INTO v_maturity, v_parent
    FROM public.deposit_tranches
    WHERE id = p_parent_tranche_id AND user_id = p_user_id
      AND status = 'locked' AND remaining > 0
    FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Active tranche not found'; END IF;
  END IF;

  SELECT balance INTO v_balance FROM public.wallets
  WHERE user_id = p_user_id AND currency = p_currency FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Credit wallet not found'; END IF;

  SELECT * INTO v_existing FROM public.transactions
  WHERE user_id = p_user_id AND reference = v_reference;
  IF FOUND THEN
    IF v_existing.type <> 'bonus' OR v_existing.currency <> p_currency
       OR v_existing.amount <> v_amount THEN
      RAISE EXCEPTION 'This request identifier was already used for different details';
    END IF;
    RETURN v_balance;
  END IF;

  UPDATE public.wallets
  SET balance = balance + v_amount, updated_at = now()
  WHERE user_id = p_user_id AND currency = p_currency
  RETURNING balance INTO v_balance;

  INSERT INTO public.transactions (
    user_id, type, currency, amount, status, description, reference
  ) VALUES (
    p_user_id, 'bonus', p_currency, v_amount, 'completed',
    COALESCE(NULLIF(left(trim(COALESCE(p_note, '')), 200), ''), 'Administrator credit'),
    v_reference
  ) RETURNING id INTO v_tx;

  INSERT INTO public.deposit_tranches (
    user_id, currency, amount, remaining, current_balance, status, source,
    parent_tranche_id, transaction_id, maturity_date, approved
  ) VALUES (
    p_user_id, p_currency, v_amount, v_amount, v_amount,
    CASE WHEN p_hold_rule = 'instant' THEN 'matured' ELSE 'locked' END,
    'bonus', v_parent, v_tx, v_maturity, true
  );

  RETURN v_balance;
END;
$$;

-- A concurrent account-ID collision should be retried inside the signup
-- transaction rather than surfacing as a generic Auth database error.
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  new_account_id text;
  attempt integer;
BEGIN
  FOR attempt IN 1..10 LOOP
    new_account_id := public.generate_account_id();
    BEGIN
      INSERT INTO public.profiles (
        id, account_id, first_name, surname, email, phone, primary_currency,
        bank_name, bank_account_number
      ) VALUES (
        NEW.id, new_account_id,
        COALESCE(NEW.raw_user_meta_data->>'first_name', ''),
        COALESCE(NEW.raw_user_meta_data->>'surname', ''),
        COALESCE(NEW.email, ''),
        COALESCE(NEW.raw_user_meta_data->>'phone', ''),
        CASE WHEN NEW.raw_user_meta_data->>'primary_currency' IN ('ZAR', 'USD')
          THEN NEW.raw_user_meta_data->>'primary_currency' ELSE 'ZAR' END,
        NULLIF(trim(COALESCE(NEW.raw_user_meta_data->>'bank_name', '')), ''),
        NULLIF(trim(COALESCE(NEW.raw_user_meta_data->>'bank_account_number', '')), '')
      );
      EXIT;
    EXCEPTION WHEN unique_violation THEN
      IF attempt = 10 THEN
        RAISE EXCEPTION 'Unable to allocate a unique account number. Please try again.';
      END IF;
    END;
  END LOOP;

  INSERT INTO public.wallets(user_id, currency, balance) VALUES
    (NEW.id, 'ZAR', 0), (NEW.id, 'NGN', 0), (NEW.id, 'GHS', 0), (NEW.id, 'USD', 0);
  INSERT INTO public.user_roles(user_id, role) VALUES(NEW.id, 'user');
  IF lower(COALESCE(NEW.email, '')) = 'sparkleinsure@gmail.com' THEN
    INSERT INTO public.user_roles(user_id, role) VALUES(NEW.id, 'admin') ON CONFLICT DO NOTHING;
  END IF;

  PERFORM public.remember_signup_signal(NEW.id, 'email', lower(trim(COALESCE(NEW.email, ''))));
  PERFORM public.remember_signup_signal(NEW.id, 'phone', public.normalize_signup_phone(NEW.raw_user_meta_data->>'phone'));
  PERFORM public.remember_signup_signal(NEW.id, 'installation', NEW.raw_user_meta_data->>'installation_id');
  PERFORM public.remember_signup_signal(NEW.id, 'system', NEW.raw_user_meta_data->>'system_fingerprint');
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.request_withdrawal_idempotent_secure(numeric, text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_refund_withdrawal_secure(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.move_withdrawable_to_growing_idempotent_secure(numeric, text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_credit_bonus_idempotent_secure(uuid, text, numeric, text, text, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.request_withdrawal_idempotent_secure(numeric, text, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_refund_withdrawal_secure(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.move_withdrawable_to_growing_idempotent_secure(numeric, text, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_credit_bonus_idempotent_secure(uuid, text, numeric, text, text, uuid, uuid) TO authenticated;
