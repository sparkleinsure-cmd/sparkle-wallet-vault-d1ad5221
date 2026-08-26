-- A selfie or uploaded photo, followed by administrator approval, is the only
-- document requirement for the R10 welcome bonus. Registered payout details
-- remain available for withdrawals but no longer gate the welcome bonus.
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
  IF NOT FOUND OR v_profile.kyc_status<>'verified' OR v_profile.selfie_url IS NULL THEN
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
