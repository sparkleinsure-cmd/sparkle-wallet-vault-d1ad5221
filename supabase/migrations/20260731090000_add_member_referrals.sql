CREATE TABLE IF NOT EXISTS public.referrals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  referrer_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  referred_user_id uuid NOT NULL UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE,
  referral_code text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  first_deposit_transaction_id uuid UNIQUE REFERENCES public.transactions(id) ON DELETE SET NULL,
  first_deposit_amount numeric(18,2),
  reward_amount numeric(18,2),
  reward_currency text,
  rewarded_at timestamptz,
  CONSTRAINT referrals_not_self CHECK (referrer_id <> referred_user_id)
);

CREATE INDEX IF NOT EXISTS referrals_referrer_id_idx ON public.referrals(referrer_id);
ALTER TABLE public.referrals ENABLE ROW LEVEL SECURITY;
CREATE POLICY "members can read their referrals" ON public.referrals FOR SELECT TO authenticated
  USING (auth.uid() = referrer_id OR auth.uid() = referred_user_id);
GRANT SELECT ON public.referrals TO authenticated;
GRANT ALL ON public.referrals TO service_role;

CREATE OR REPLACE FUNCTION public.register_my_referral(p_referral_code text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_referrer_id uuid;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Unauthorized'; END IF;
  SELECT id INTO v_referrer_id FROM public.profiles
  WHERE upper(account_id) = upper(trim(COALESCE(p_referral_code, ''))) LIMIT 1;
  IF v_referrer_id IS NULL THEN RAISE EXCEPTION 'Invalid referral link'; END IF;
  IF v_referrer_id = auth.uid() THEN RAISE EXCEPTION 'You cannot refer yourself'; END IF;
  IF EXISTS (SELECT 1 FROM public.transactions WHERE user_id = auth.uid() AND type = 'deposit') THEN
    RAISE EXCEPTION 'A referral cannot be added after a deposit has been submitted';
  END IF;
  INSERT INTO public.referrals (referrer_id, referred_user_id, referral_code)
  VALUES (v_referrer_id, auth.uid(), upper(trim(p_referral_code)))
  ON CONFLICT (referred_user_id) DO NOTHING;
  RETURN EXISTS (SELECT 1 FROM public.referrals
    WHERE referred_user_id = auth.uid() AND referrer_id = v_referrer_id);
END;
$$;
REVOKE ALL ON FUNCTION public.register_my_referral(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.register_my_referral(text) TO authenticated;

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
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(), 'admin'::public.app_role) THEN RAISE EXCEPTION 'Forbidden'; END IF;
  SELECT * INTO v_tx FROM public.transactions WHERE id = p_tx_id FOR UPDATE;
  IF NOT FOUND OR v_tx.type <> 'deposit' OR v_tx.status <> 'pending' THEN RAISE EXCEPTION 'Deposit not found or already processed'; END IF;
  v_amount := COALESCE(p_corrected_amount, v_tx.amount);
  IF v_amount <= 0 OR v_amount > 10000000 THEN RAISE EXCEPTION 'Invalid amount'; END IF;

  UPDATE public.transactions SET amount = round(v_amount, 2), status = 'completed',
    description = 'Deposit verified by admin' || CASE WHEN length(trim(COALESCE(p_note, ''))) > 0
      THEN ' — ' || left(trim(p_note), 300) ELSE '' END WHERE id = v_tx.id;
  UPDATE public.wallets SET balance = balance + round(v_amount, 2), updated_at = now()
    WHERE user_id = v_tx.user_id AND currency = v_tx.currency;
  INSERT INTO public.deposit_tranches (user_id, currency, amount, remaining, current_balance, status, source, transaction_id, maturity_date, approved)
  VALUES (v_tx.user_id, v_tx.currency, round(v_amount, 2), round(v_amount, 2), round(v_amount, 2), 'locked', 'deposit', v_tx.id, now() + interval '30 days', true);

  SELECT * INTO v_referral FROM public.referrals
    WHERE referred_user_id = v_tx.user_id AND rewarded_at IS NULL FOR UPDATE;
  IF FOUND AND v_referral.created_at <= v_tx.created_at AND v_tx.id = (SELECT id FROM public.transactions
    WHERE user_id = v_tx.user_id AND type = 'deposit' AND status = 'completed'
    ORDER BY created_at, id LIMIT 1) THEN
    v_reward := round(v_amount * 0.10, 2);
    IF v_reward > 0 THEN
      UPDATE public.wallets SET balance = balance + v_reward, updated_at = now()
        WHERE user_id = v_referral.referrer_id AND currency = v_tx.currency;
      INSERT INTO public.transactions (user_id, type, currency, amount, status, description, reference)
      VALUES (v_referral.referrer_id, 'bonus', v_tx.currency, v_reward, 'completed', '10% referral bonus', 'REF-' || left(v_referral.id::text, 8))
      RETURNING id INTO v_reward_tx_id;
      INSERT INTO public.deposit_tranches (user_id, currency, amount, remaining, current_balance, status, source, transaction_id, maturity_date, approved, note)
      VALUES (v_referral.referrer_id, v_tx.currency, v_reward, v_reward, v_reward, 'matured', 'referral', v_reward_tx_id, now(), true, 'Immediately withdrawable referral reward');
      UPDATE public.referrals SET first_deposit_transaction_id = v_tx.id,
        first_deposit_amount = round(v_amount, 2), reward_amount = v_reward,
        reward_currency = v_tx.currency, rewarded_at = now() WHERE id = v_referral.id;
    END IF;
  END IF;
  RETURN round(v_amount, 2);
END;
$$;
REVOKE ALL ON FUNCTION public.admin_approve_deposit_secure(uuid,numeric,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_approve_deposit_secure(uuid,numeric,text) TO authenticated;
