-- Persist referral attribution inside the signup transaction. This avoids
-- losing the referral when an in-app browser opens email confirmation in a
-- different browser whose localStorage is not shared.
CREATE OR REPLACE FUNCTION public.capture_signup_referral()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_code text := upper(trim(COALESCE(NEW.raw_user_meta_data->>'referral_code', '')));
  v_referrer_id uuid;
BEGIN
  IF v_code = '' THEN RETURN NEW; END IF;

  SELECT id INTO v_referrer_id
  FROM public.profiles
  WHERE upper(account_id) = v_code
  LIMIT 1;

  -- Invalid and self-referral codes must never prevent account creation.
  IF v_referrer_id IS NULL OR v_referrer_id = NEW.id THEN RETURN NEW; END IF;

  INSERT INTO public.referrals (referrer_id, referred_user_id, referral_code, created_at)
  VALUES (v_referrer_id, NEW.id, v_code, COALESCE(NEW.created_at, now()))
  ON CONFLICT (referred_user_id) DO NOTHING;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS zz_capture_signup_referral ON auth.users;
CREATE TRIGGER zz_capture_signup_referral
AFTER INSERT ON auth.users
FOR EACH ROW EXECUTE FUNCTION public.capture_signup_referral();

REVOKE ALL ON FUNCTION public.capture_signup_referral() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.capture_signup_referral() TO service_role;
