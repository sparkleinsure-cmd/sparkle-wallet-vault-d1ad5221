-- The original referral bonus transaction and mature tranche exist for member
-- 64A3FHNE, but their wallet was never credited. Record this exceptional
-- repair against the original transaction so it is impossible to apply twice.
CREATE TABLE IF NOT EXISTS public.referral_wallet_credit_repairs (
  transaction_id uuid PRIMARY KEY REFERENCES public.transactions(id) ON DELETE CASCADE,
  repaired_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.referral_wallet_credit_repairs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.referral_wallet_credit_repairs FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.referral_wallet_credit_repairs TO service_role;

DO $$
DECLARE
  v_member_id uuid;
  v_tranche public.deposit_tranches%ROWTYPE;
  v_claimed_transaction_id uuid;
BEGIN
  SELECT id INTO v_member_id
  FROM public.profiles
  WHERE account_id = '64A3FHNE';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Referral wallet repair aborted: member 64A3FHNE was not found';
  END IF;

  SELECT * INTO v_tranche
  FROM public.deposit_tranches
  WHERE user_id = v_member_id
    AND currency = 'ZAR'
    AND source = 'referral'
    AND status = 'matured'
    AND amount = 200.00
    AND remaining = 200.00
    AND current_balance = 200.00
  ORDER BY created_at DESC
  LIMIT 1
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Referral wallet repair aborted: expected mature R200 referral tranche was not found';
  END IF;

  SELECT id INTO v_claimed_transaction_id
  FROM public.transactions
  WHERE id = v_tranche.transaction_id
    AND user_id = v_member_id
    AND type = 'bonus'
    AND currency = 'ZAR'
    AND amount = 200.00
    AND status = 'completed'
    AND description = '10% referral bonus'
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Referral wallet repair aborted: expected referral transaction was not found';
  END IF;

  INSERT INTO public.referral_wallet_credit_repairs (transaction_id)
  VALUES (v_claimed_transaction_id)
  ON CONFLICT DO NOTHING;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  UPDATE public.wallets
  SET balance = balance + 200.00, updated_at = now()
  WHERE user_id = v_member_id AND currency = 'ZAR';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Referral wallet repair aborted: member ZAR wallet was not found';
  END IF;
END;
$$;
