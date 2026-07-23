-- Allow deleted members to register again while keeping only irreversible
-- identity signals needed to enforce the one-person/one-device welcome bonus.
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;

CREATE TABLE IF NOT EXISTS public.signup_identity_history (
  signal_type text NOT NULL CHECK (signal_type IN ('email','phone','installation','system','network')),
  signal_hash text NOT NULL CHECK (length(signal_hash) = 64),
  first_user_id uuid NOT NULL,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  bonus_claimed_at timestamptz,
  PRIMARY KEY (signal_type, signal_hash)
);

CREATE TABLE IF NOT EXISTS public.signup_risk_signals (
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  signal_type text NOT NULL CHECK (signal_type IN ('email','phone','installation','system','network')),
  signal_hash text NOT NULL CHECK (length(signal_hash) = 64),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, signal_type, signal_hash)
);

CREATE INDEX IF NOT EXISTS signup_risk_signals_lookup_idx
  ON public.signup_risk_signals(signal_type, signal_hash);

ALTER TABLE public.signup_identity_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.signup_risk_signals ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.signup_identity_history, public.signup_risk_signals FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.signup_identity_history, public.signup_risk_signals TO service_role;

CREATE OR REPLACE FUNCTION public.signup_signal_hash(value text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = public, extensions
AS $$
  SELECT encode(extensions.digest(trim(COALESCE(value, '')), 'sha256'), 'hex')
$$;

CREATE OR REPLACE FUNCTION public.remember_signup_signal(
  p_user_id uuid, p_signal_type text, p_value text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE v_hash text;
BEGIN
  IF p_signal_type NOT IN ('email','phone','installation','system','network')
     OR length(trim(COALESCE(p_value, ''))) < 3 THEN
    RETURN;
  END IF;
  v_hash := public.signup_signal_hash(p_value);
  INSERT INTO public.signup_risk_signals(user_id, signal_type, signal_hash)
    VALUES (p_user_id, p_signal_type, v_hash) ON CONFLICT DO NOTHING;
  INSERT INTO public.signup_identity_history(signal_type, signal_hash, first_user_id)
    VALUES (p_signal_type, v_hash, p_user_id) ON CONFLICT DO NOTHING;
END;
$$;

-- Capture network/HTTP-client signals through the authenticated Edge Function.
-- The function receives an already SHA-256-hashed value, never a raw IP address.
CREATE OR REPLACE FUNCTION public.remember_signup_signal_hash(
  p_user_id uuid, p_signal_type text, p_signal_hash text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_signal_type NOT IN ('network','system')
     OR p_signal_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'Invalid signup signal';
  END IF;
  INSERT INTO public.signup_risk_signals(user_id, signal_type, signal_hash)
    VALUES (p_user_id, p_signal_type, p_signal_hash) ON CONFLICT DO NOTHING;
  INSERT INTO public.signup_identity_history(signal_type, signal_hash, first_user_id)
    VALUES (p_signal_type, p_signal_hash, p_user_id) ON CONFLICT DO NOTHING;
END;
$$;

REVOKE ALL ON FUNCTION public.signup_signal_hash(text),
  public.remember_signup_signal(uuid,text,text),
  public.remember_signup_signal_hash(uuid,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.remember_signup_signal(uuid,text,text),
  public.remember_signup_signal_hash(uuid,text,text) TO service_role;

-- Backfill existing accounts before replacing the signup trigger.
DO $$
DECLARE p record;
BEGIN
  FOR p IN SELECT id,email,phone,welcome_bonus_credited_at FROM public.profiles LOOP
    PERFORM public.remember_signup_signal(p.id, 'email', lower(trim(p.email)));
    PERFORM public.remember_signup_signal(p.id, 'phone', public.normalize_signup_phone(p.phone));
    IF p.welcome_bonus_credited_at IS NOT NULL THEN
      UPDATE public.signup_identity_history h SET bonus_claimed_at=p.welcome_bonus_credited_at
      FROM public.signup_risk_signals s
      WHERE s.user_id=p.id AND h.signal_type=s.signal_type AND h.signal_hash=s.signal_hash;
    END IF;
  END LOOP;
END $$;

-- Account cascades must not create a fresh health snapshot for a user that is
-- being removed. The old DELETE trigger did exactly that and could block every
-- hard deletion with a NOT NULL / foreign-key failure.
DROP TRIGGER IF EXISTS wallet_health_on_wallet_change ON public.wallets;
CREATE CONSTRAINT TRIGGER wallet_health_on_wallet_change
AFTER INSERT OR UPDATE OF balance ON public.wallets
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION public.refresh_wallet_health_from_activity();

DROP TRIGGER IF EXISTS wallet_health_on_transaction_change ON public.transactions;
CREATE CONSTRAINT TRIGGER wallet_health_on_transaction_change
AFTER INSERT OR UPDATE OF status,amount,currency,description ON public.transactions
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION public.refresh_wallet_health_from_activity();

-- Finish deletions created by the previous soft-delete implementation. Their
-- hashed signup history has been retained above; all active app records now
-- cascade away and their email addresses become available for registration.
UPDATE public.insurance_applications a SET reviewed_by=NULL
FROM auth.users u WHERE a.reviewed_by=u.id AND u.deleted_at IS NOT NULL;
UPDATE public.insurance_claims c SET reviewed_by=NULL
FROM auth.users u WHERE c.reviewed_by=u.id AND u.deleted_at IS NOT NULL;
DELETE FROM auth.users WHERE deleted_at IS NOT NULL;

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE new_account_id text;
BEGIN
  new_account_id := public.generate_account_id();
  INSERT INTO public.profiles (
    id,account_id,first_name,surname,email,phone,primary_currency,bank_name,bank_account_number
  ) VALUES (
    NEW.id,new_account_id,
    COALESCE(NEW.raw_user_meta_data->>'first_name',''),
    COALESCE(NEW.raw_user_meta_data->>'surname',''),
    COALESCE(NEW.email,''),
    COALESCE(NEW.raw_user_meta_data->>'phone',''),
    COALESCE(NEW.raw_user_meta_data->>'primary_currency','ZAR'),
    NULLIF(trim(COALESCE(NEW.raw_user_meta_data->>'bank_name','')),''),
    NULLIF(trim(COALESCE(NEW.raw_user_meta_data->>'bank_account_number','')),'')
  );
  INSERT INTO public.wallets(user_id,currency,balance) VALUES
    (NEW.id,'ZAR',0),(NEW.id,'NGN',0),(NEW.id,'GHS',0),(NEW.id,'USD',0);
  INSERT INTO public.user_roles(user_id,role) VALUES(NEW.id,'user');
  IF lower(COALESCE(NEW.email,''))='sparkleinsure@gmail.com' THEN
    INSERT INTO public.user_roles(user_id,role) VALUES(NEW.id,'admin') ON CONFLICT DO NOTHING;
  END IF;

  PERFORM public.remember_signup_signal(NEW.id,'email',lower(trim(COALESCE(NEW.email,''))));
  PERFORM public.remember_signup_signal(NEW.id,'phone',public.normalize_signup_phone(NEW.raw_user_meta_data->>'phone'));
  PERFORM public.remember_signup_signal(NEW.id,'installation',NEW.raw_user_meta_data->>'installation_id');
  PERFORM public.remember_signup_signal(NEW.id,'system',NEW.raw_user_meta_data->>'system_fingerprint');
  RETURN NEW;
END;
$$;

-- Preserve the current verification behavior but award only when every
-- available signal belongs to this account's original signup.
CREATE OR REPLACE FUNCTION public.admin_set_kyc_status(p_user_id uuid,p_status public.kyc_status)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_tx uuid;
BEGIN
  IF NOT public.has_role(auth.uid(),'admin') THEN RAISE EXCEPTION 'Forbidden'; END IF;
  IF p_status NOT IN ('verified'::public.kyc_status,'rejected'::public.kyc_status) THEN RAISE EXCEPTION 'Invalid status'; END IF;
  UPDATE public.profiles SET kyc_status=p_status WHERE id=p_user_id;

  IF p_status='verified'
     AND EXISTS (
       SELECT 1 FROM public.profiles WHERE id=p_user_id AND selfie_url IS NOT NULL
       AND bank_name IS NOT NULL AND bank_account_number IS NOT NULL
       AND welcome_bonus_credited_at IS NULL
     )
     AND NOT EXISTS (
       SELECT 1
       FROM public.signup_risk_signals s
       JOIN public.signup_identity_history h
         ON h.signal_type=s.signal_type AND h.signal_hash=s.signal_hash
       WHERE s.user_id=p_user_id AND h.first_user_id<>p_user_id
         -- Shared/public IP addresses are retained as a risk signal but never
         -- reject a household member on their own.
         AND s.signal_type<>'network'
     ) THEN
    UPDATE public.wallets SET balance=balance+10,updated_at=now()
      WHERE user_id=p_user_id AND currency='ZAR';
    INSERT INTO public.transactions(user_id,type,currency,amount,status,description,reference)
      VALUES(p_user_id,'bonus','ZAR',10,'completed','R10 welcome bonus','WELCOME-'||p_user_id::text)
      RETURNING id INTO v_tx;
    INSERT INTO public.deposit_tranches(user_id,currency,amount,remaining,current_balance,
      status,source,transaction_id,maturity_date,approved,note)
      VALUES(p_user_id,'ZAR',10,10,10,'locked','bonus',v_tx,now()+interval '30 days',true,'R10 welcome bonus');
    UPDATE public.profiles SET welcome_bonus_credited_at=now() WHERE id=p_user_id;
    UPDATE public.signup_identity_history h SET bonus_claimed_at=COALESCE(h.bonus_claimed_at,now())
    FROM public.signup_risk_signals s
    WHERE s.user_id=p_user_id AND h.signal_type=s.signal_type AND h.signal_hash=s.signal_hash;
  END IF;
END;
$$;
