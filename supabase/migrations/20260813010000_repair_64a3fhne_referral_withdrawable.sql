-- Repair the reported referral reward without changing any other member's
-- balances. The referral tranche and its completed bonus ledger entry exist,
-- but the matching R200 wallet credit was not applied, leaving the matured
-- reward unavailable for withdrawal.
DO $$
DECLARE
  v_member_id uuid;
  v_wallet public.wallets%ROWTYPE;
  v_referral_tranche public.deposit_tranches%ROWTYPE;
BEGIN
  SELECT id INTO v_member_id
  FROM public.profiles
  WHERE account_id = '64A3FHNE';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Referral repair aborted: member 64A3FHNE was not found';
  END IF;

  SELECT * INTO v_referral_tranche
  FROM public.deposit_tranches
  WHERE user_id = v_member_id
    AND currency = 'ZAR'
    AND source = 'referral'
    AND status = 'matured'
    AND amount = 200.00
    AND remaining = 200.00
    AND current_balance = 200.00
  ORDER BY created_at DESC
  LIMIT 1;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Referral repair aborted: expected matured R200 referral tranche was not found';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.transactions
    WHERE id = v_referral_tranche.transaction_id
      AND user_id = v_member_id
      AND type = 'bonus'
      AND currency = 'ZAR'
      AND amount = 200.00
      AND status = 'completed'
      AND description = '10% referral bonus'
  ) THEN
    RAISE EXCEPTION 'Referral repair aborted: expected completed referral bonus ledger entry was not found';
  END IF;

  SELECT * INTO v_wallet
  FROM public.wallets
  WHERE user_id = v_member_id AND currency = 'ZAR'
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Referral repair aborted: ZAR wallet was not found';
  END IF;

  -- The reported wallet balance is the pre-credit value. This guard makes the
  -- migration a no-op if the account has since been corrected or transacted.
  IF v_wallet.balance = 7883.74 THEN
    UPDATE public.wallets
    SET balance = balance + 200.00, updated_at = now()
    WHERE id = v_wallet.id;
  END IF;
END;
$$;
