-- Members may voluntarily start a new 30-day cycle with funds that are
-- currently withdrawable. This is intentionally one-way: active growing
-- cycles still cannot be moved back to withdrawable before maturity.
ALTER TYPE public.tx_type ADD VALUE IF NOT EXISTS 'transfer';

CREATE OR REPLACE FUNCTION public.move_withdrawable_to_growing_secure(
  p_amount numeric,
  p_currency text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_amount numeric;
  v_wallet public.wallets%ROWTYPE;
  v_profile public.profiles%ROWTYPE;
  v_tranche public.deposit_tranches%ROWTYPE;
  v_locked numeric := 0;
  v_withdrawable numeric;
  v_remaining numeric;
  v_take numeric;
  v_gain numeric;
  v_tx uuid;
  v_maturity timestamptz;
BEGIN
  IF auth.uid() IS NULL OR p_currency NOT IN ('ZAR', 'USD') THEN
    RAISE EXCEPTION 'Invalid transfer request';
  END IF;

  v_amount := round(p_amount, 2);
  IF v_amount < 0.01 OR v_amount > 10000000 THEN
    RAISE EXCEPTION 'Enter a valid amount';
  END IF;

  SELECT * INTO v_profile
  FROM public.profiles
  WHERE id = auth.uid();

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Profile not found';
  END IF;
  IF COALESCE(v_profile.account_frozen, false) THEN
    RAISE EXCEPTION 'Your account is frozen while a compliance review is in progress';
  END IF;

  -- Settle this member's due cycles before calculating withdrawable funds. The
  -- settlement row and transaction reference make this safe alongside cron.
  FOR v_tranche IN
    SELECT * FROM public.deposit_tranches
    WHERE user_id = auth.uid()
      AND currency = p_currency
      AND status = 'locked'
      AND approved = true
      AND maturity_date <= now()
      AND remaining > 0
      AND current_balance > 0
    ORDER BY maturity_date, created_at
    FOR UPDATE
  LOOP
    v_gain := greatest(0, COALESCE(v_tranche.current_balance, v_tranche.remaining) - v_tranche.remaining);
    INSERT INTO public.tranche_maturity_settlements (tranche_id, gain)
    VALUES (v_tranche.id, v_gain)
    ON CONFLICT DO NOTHING;
    IF FOUND THEN
      IF v_gain > 0 THEN
        UPDATE public.wallets
        SET balance = balance + v_gain, updated_at = now()
        WHERE user_id = auth.uid() AND currency = p_currency;
        INSERT INTO public.transactions (user_id, type, currency, amount, status, description, reference)
        VALUES (auth.uid(), 'bonus', p_currency, v_gain, 'completed',
          'Matured tranche incentive (30-day cycle)', 'MATURITY-' || v_tranche.id::text);
      END IF;
      UPDATE public.deposit_tranches
      SET status = 'matured', current_balance = remaining
      WHERE id = v_tranche.id;
    END IF;
  END LOOP;

  SELECT * INTO v_wallet
  FROM public.wallets
  WHERE user_id = auth.uid() AND currency = p_currency
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Wallet not found';
  END IF;

  SELECT COALESCE(sum(remaining), 0) INTO v_locked
  FROM public.deposit_tranches
  WHERE user_id = auth.uid()
    AND currency = p_currency
    AND status = 'locked'
    AND maturity_date > now()
    AND remaining > 0;

  v_withdrawable := greatest(0, v_wallet.balance - v_locked);
  IF v_amount > v_withdrawable THEN
    RAISE EXCEPTION 'Only withdrawable funds can be moved to growing';
  END IF;

  -- Retire matured cycle balances first before representing the same value in
  -- a new locked cycle. Liquid bonuses without a tranche need no cleanup.
  v_remaining := v_amount;
  FOR v_tranche IN
    SELECT * FROM public.deposit_tranches
    WHERE user_id = auth.uid()
      AND currency = p_currency
      AND status = 'matured'
      AND remaining > 0
    ORDER BY maturity_date, created_at
    FOR UPDATE
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
    'Moved from withdrawable to growing balance - new 30-day cycle',
    'GROW-' || gen_random_uuid()::text
  )
  RETURNING id INTO v_tx;

  INSERT INTO public.deposit_tranches (
    user_id, currency, amount, remaining, current_balance, status, source,
    transaction_id, maturity_date, approved, note
  ) VALUES (
    auth.uid(), p_currency, v_amount, v_amount, v_amount, 'locked', 'transfer',
    v_tx, v_maturity, true, 'Moved from withdrawable balance'
  );

  RETURN jsonb_build_object(
    'ok', true,
    'amount', v_amount,
    'currency', p_currency,
    'maturityDate', v_maturity,
    'transactionId', v_tx
  );
END;
$$;

-- Withdrawals remain matured-only, but now retire the matching matured tranche
-- balances so withdrawn funds cannot continue to appear as funded cycles.
CREATE OR REPLACE FUNCTION public.request_withdrawal_secure(
  p_amount numeric,
  p_currency text,
  p_bank_name text DEFAULT NULL,
  p_account_number text DEFAULT NULL,
  p_confirm_break boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_wallet public.wallets%ROWTYPE;
  v_profile public.profiles%ROWTYPE;
  v_tranche public.deposit_tranches%ROWTYPE;
  v_locked numeric := 0;
  v_withdrawable numeric;
  v_remaining numeric;
  v_take numeric;
  v_gain numeric;
  v_tx uuid;
BEGIN
  IF auth.uid() IS NULL
     OR p_currency NOT IN ('ZAR', 'USD')
     OR p_amount <= 0
     OR p_amount > 10000000 THEN
    RAISE EXCEPTION 'Invalid withdrawal request';
  END IF;

  SELECT * INTO v_profile
  FROM public.profiles
  WHERE id = auth.uid();

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

  -- Lock and settle due cycles before locking the wallet. This matches the
  -- maturity job's lock order and prevents a maturity/withdrawal race.
  FOR v_tranche IN
    SELECT * FROM public.deposit_tranches
    WHERE user_id = auth.uid()
      AND currency = p_currency
      AND status = 'locked'
      AND approved = true
      AND maturity_date <= now()
      AND remaining > 0
      AND current_balance > 0
    ORDER BY maturity_date, created_at
    FOR UPDATE
  LOOP
    v_gain := greatest(0, COALESCE(v_tranche.current_balance, v_tranche.remaining) - v_tranche.remaining);
    INSERT INTO public.tranche_maturity_settlements (tranche_id, gain)
    VALUES (v_tranche.id, v_gain)
    ON CONFLICT DO NOTHING;
    IF FOUND THEN
      IF v_gain > 0 THEN
        UPDATE public.wallets
        SET balance = balance + v_gain, updated_at = now()
        WHERE user_id = auth.uid() AND currency = p_currency;
        INSERT INTO public.transactions (user_id, type, currency, amount, status, description, reference)
        VALUES (auth.uid(), 'bonus', p_currency, v_gain, 'completed',
          'Matured tranche incentive (30-day cycle)', 'MATURITY-' || v_tranche.id::text);
      END IF;
      UPDATE public.deposit_tranches
      SET status = 'matured', current_balance = remaining
      WHERE id = v_tranche.id;
    END IF;
  END LOOP;

  SELECT * INTO v_wallet
  FROM public.wallets
  WHERE user_id = auth.uid() AND currency = p_currency
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Wallet not found';
  END IF;
  IF p_amount > v_wallet.balance THEN
    RAISE EXCEPTION 'Insufficient balance';
  END IF;

  SELECT COALESCE(sum(remaining), 0) INTO v_locked
  FROM public.deposit_tranches
  WHERE user_id = auth.uid()
    AND currency = p_currency
    AND status = 'locked'
    AND maturity_date > now()
    AND remaining > 0;

  v_withdrawable := greatest(0, v_wallet.balance - v_locked);
  IF p_amount > v_withdrawable THEN
    RAISE EXCEPTION 'Only matured funds are withdrawable. Locked 30-day cycles cannot be withdrawn early.';
  END IF;

  -- Matured tranches are accounting records for available funds. Consume them
  -- FIFO; completed rows remain in the database and transaction history.
  v_remaining := p_amount;
  FOR v_tranche IN
    SELECT * FROM public.deposit_tranches
    WHERE user_id = auth.uid()
      AND currency = p_currency
      AND status = 'matured'
      AND remaining > 0
    ORDER BY maturity_date, created_at
    FOR UPDATE
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
    auth.uid(), 'withdrawal', p_currency, round(p_amount, 2), 'pending',
    'Withdrawal request - ' || v_profile.bank_name || ' account ending ' || right(v_profile.bank_account_number, 4),
    'WITHDRAWAL-' || gen_random_uuid()::text
  )
  RETURNING id INTO v_tx;

  UPDATE public.wallets
  SET balance = balance - p_amount, updated_at = now()
  WHERE id = v_wallet.id;

  RETURN jsonb_build_object(
    'grossAmount', p_amount,
    'penalty', 0,
    'payoutAmount', p_amount,
    'accountLast4', right(v_profile.bank_account_number, 4),
    'withdrawalId', v_tx
  );
END;
$$;

REVOKE ALL ON FUNCTION public.move_withdrawable_to_growing_secure(numeric, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.request_withdrawal_secure(numeric, text, text, text, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.move_withdrawable_to_growing_secure(numeric, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.request_withdrawal_secure(numeric, text, text, text, boolean) TO authenticated;
