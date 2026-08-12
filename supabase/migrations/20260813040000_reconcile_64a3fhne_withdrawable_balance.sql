-- Reconcile the R133.30 pre-existing wallet shortfall on the reported member.
-- The R200 referral credit was correctly applied by the preceding repair, but
-- the wallet still sat R133.30 below the locked-cycle principal, leaving only
-- R66.70 withdrawable. This does not change any tranche or maturity date.
CREATE TABLE IF NOT EXISTS public.wallet_reconciliation_repairs (
  repair_key text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  currency text NOT NULL,
  amount numeric(18,2) NOT NULL CHECK (amount <> 0),
  repaired_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.wallet_reconciliation_repairs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.wallet_reconciliation_repairs FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.wallet_reconciliation_repairs TO service_role;

DO $$
DECLARE
  v_member_id uuid;
  v_wallet public.wallets%ROWTYPE;
  v_locked numeric;
BEGIN
  SELECT id INTO v_member_id FROM public.profiles WHERE account_id = '64A3FHNE';
  IF NOT FOUND THEN RAISE EXCEPTION 'Wallet reconciliation aborted: member 64A3FHNE was not found'; END IF;

  SELECT * INTO v_wallet
  FROM public.wallets
  WHERE user_id = v_member_id AND currency = 'ZAR'
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Wallet reconciliation aborted: ZAR wallet was not found'; END IF;

  SELECT COALESCE(sum(remaining), 0) INTO v_locked
  FROM public.deposit_tranches
  WHERE user_id = v_member_id AND currency = 'ZAR' AND status = 'locked'
    AND maturity_date > now() AND remaining > 0;

  -- Guard against applying this historical correction after unrelated account
  -- activity: it is valid only for the audited R7,110 / R7,043.30 state.
  IF v_wallet.balance <> 7110.00 OR v_locked <> 7043.30 THEN
    RAISE EXCEPTION 'Wallet reconciliation aborted: audited balance state no longer matches';
  END IF;

  INSERT INTO public.wallet_reconciliation_repairs (repair_key, user_id, currency, amount)
  VALUES ('64A3FHNE-referral-withdrawable-shortfall', v_member_id, 'ZAR', 133.30)
  ON CONFLICT DO NOTHING;
  IF NOT FOUND THEN RETURN; END IF;

  UPDATE public.wallets
  SET balance = balance + 133.30, updated_at = now()
  WHERE id = v_wallet.id;

  INSERT INTO public.transactions (user_id, type, currency, amount, status, description, reference)
  VALUES (
    v_member_id, 'bonus', 'ZAR', 133.30, 'completed',
    'Wallet reconciliation: referral reward withdrawable shortfall',
    'RECON-64A3FHNE-REFERRAL'
  );
END;
$$;
