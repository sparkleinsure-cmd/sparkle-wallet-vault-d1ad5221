-- Allow an administrator to exempt one exact app/browser installation used
-- for controlled welcome-bonus testing. Email and phone reuse still block a
-- repeated claim, and the exemption is never based on a spoofable model name.
CREATE TABLE IF NOT EXISTS public.bonus_test_installations (
  signal_hash text PRIMARY KEY CHECK (signal_hash ~ '^[0-9a-f]{64}$'),
  label text NOT NULL CHECK (length(trim(label)) BETWEEN 3 AND 80),
  registered_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.bonus_test_installations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.bonus_test_installations FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.bonus_test_installations TO service_role;

CREATE OR REPLACE FUNCTION public.submit_kyc_review(p_proof_path text,p_selfie_path text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=public
AS $$
DECLARE v_profile public.profiles%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL OR length(trim(COALESCE(p_selfie_path,'')))<3
     OR split_part(p_selfie_path,'/',1)<>auth.uid()::text
     OR (p_proof_path IS NOT NULL AND split_part(p_proof_path,'/',1)<>auth.uid()::text) THEN
    RAISE EXCEPTION 'Invalid verification submission';
  END IF;

  SELECT * INTO v_profile FROM public.profiles WHERE id=auth.uid() FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Profile not found'; END IF;
  IF v_profile.welcome_bonus_credited_at IS NOT NULL OR EXISTS (
    SELECT 1
    FROM public.signup_risk_signals s
    JOIN public.signup_identity_history h
      ON h.signal_type=s.signal_type AND h.signal_hash=s.signal_hash
    WHERE s.user_id=auth.uid() AND h.bonus_claimed_at IS NOT NULL
      AND (
        s.signal_type IN ('email','phone')
        OR (
          s.signal_type='installation'
          AND NOT EXISTS (
            SELECT 1 FROM public.bonus_test_installations t
            WHERE t.signal_hash=s.signal_hash
          )
        )
      )
  ) THEN
    RAISE EXCEPTION 'Welcome bonus already claimed';
  END IF;
  IF v_profile.kyc_status='pending' AND v_profile.selfie_url IS NOT NULL THEN
    RAISE EXCEPTION 'Your welcome bonus claim is already pending review';
  END IF;

  UPDATE public.profiles
    SET proof_url=COALESCE(p_proof_path,proof_url),selfie_url=p_selfie_path,kyc_status='pending'
    WHERE id=auth.uid();
END;
$$;

CREATE OR REPLACE FUNCTION public.credit_welcome_bonus_if_eligible(p_user_id uuid)
RETURNS timestamptz
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=public
AS $$
DECLARE
  v_profile public.profiles%ROWTYPE;
  v_tx uuid;
  v_claimed_at timestamptz;
BEGIN
  SELECT * INTO v_profile FROM public.profiles WHERE id=p_user_id FOR UPDATE;
  IF NOT FOUND OR v_profile.kyc_status<>'verified'
     OR v_profile.selfie_url IS NULL OR v_profile.bank_name IS NULL
     OR v_profile.bank_account_number IS NULL THEN
    RETURN NULL;
  END IF;
  IF v_profile.welcome_bonus_credited_at IS NOT NULL THEN
    RETURN v_profile.welcome_bonus_credited_at;
  END IF;

  SELECT id,created_at INTO v_tx,v_claimed_at
  FROM public.transactions
  WHERE user_id=p_user_id AND reference='WELCOME-'||p_user_id::text
  ORDER BY created_at LIMIT 1;
  IF FOUND THEN
    UPDATE public.profiles SET welcome_bonus_credited_at=v_claimed_at WHERE id=p_user_id;
    UPDATE public.signup_identity_history h SET bonus_claimed_at=COALESCE(h.bonus_claimed_at,v_claimed_at)
    FROM public.signup_risk_signals s
    WHERE s.user_id=p_user_id AND h.signal_type=s.signal_type AND h.signal_hash=s.signal_hash;
    RETURN v_claimed_at;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.signup_risk_signals s
    JOIN public.signup_identity_history h
      ON h.signal_type=s.signal_type AND h.signal_hash=s.signal_hash
    WHERE s.user_id=p_user_id AND h.first_user_id<>p_user_id
      AND (
        s.signal_type IN ('email','phone')
        OR (
          s.signal_type='installation'
          AND NOT EXISTS (
            SELECT 1 FROM public.bonus_test_installations t
            WHERE t.signal_hash=s.signal_hash
          )
        )
      )
  ) THEN
    RETURN NULL;
  END IF;

  UPDATE public.wallets SET balance=balance+10,updated_at=now()
    WHERE user_id=p_user_id AND currency='ZAR';
  IF NOT FOUND THEN RAISE EXCEPTION 'ZAR wallet not found'; END IF;

  INSERT INTO public.transactions(user_id,type,currency,amount,status,description,reference)
    VALUES(p_user_id,'bonus','ZAR',10,'completed','R10 welcome bonus','WELCOME-'||p_user_id::text)
    RETURNING id,created_at INTO v_tx,v_claimed_at;
  INSERT INTO public.deposit_tranches(
    user_id,currency,amount,remaining,current_balance,status,source,
    transaction_id,maturity_date,approved,note
  ) VALUES(
    p_user_id,'ZAR',10,10,10,'locked','bonus',
    v_tx,now()+interval '30 days',true,'R10 welcome bonus'
  );
  UPDATE public.profiles SET welcome_bonus_credited_at=v_claimed_at WHERE id=p_user_id;
  UPDATE public.signup_identity_history h SET bonus_claimed_at=COALESCE(h.bonus_claimed_at,v_claimed_at)
  FROM public.signup_risk_signals s
  WHERE s.user_id=p_user_id AND h.signal_type=s.signal_type AND h.signal_hash=s.signal_hash;
  RETURN v_claimed_at;
END;
$$;

REVOKE ALL ON FUNCTION public.credit_welcome_bonus_if_eligible(uuid) FROM PUBLIC,anon,authenticated;
