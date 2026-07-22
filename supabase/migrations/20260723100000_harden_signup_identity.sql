CREATE OR REPLACE FUNCTION public.normalize_signup_phone(value text)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT regexp_replace(COALESCE(value, ''), '[^0-9]', '', 'g')
$$;

CREATE OR REPLACE FUNCTION public.check_signup_availability(p_email text, p_phone text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_email text := lower(trim(COALESCE(p_email, ''))); v_phone text := public.normalize_signup_phone(p_phone);
BEGIN
  RETURN jsonb_build_object(
    'emailExists', EXISTS (SELECT 1 FROM public.profiles WHERE lower(email) = v_email),
    'phoneExists', EXISTS (SELECT 1 FROM public.profiles WHERE public.normalize_signup_phone(phone) = v_phone AND length(v_phone) BETWEEN 8 AND 15)
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.prevent_duplicate_profile_identity()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_phone text := public.normalize_signup_phone(NEW.phone);
BEGIN
  IF length(v_phone) NOT BETWEEN 8 AND 15 THEN RAISE EXCEPTION 'Enter a valid phone number with 8 to 15 digits'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(v_phone, 0));
  IF EXISTS (SELECT 1 FROM public.profiles WHERE id <> NEW.id AND public.normalize_signup_phone(phone) = v_phone) THEN RAISE EXCEPTION 'An account with this phone number already exists'; END IF;
  IF EXISTS (SELECT 1 FROM public.profiles WHERE id <> NEW.id AND lower(email) = lower(trim(NEW.email))) THEN RAISE EXCEPTION 'An account with this email already exists'; END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS protect_profile_identity ON public.profiles;
CREATE TRIGGER protect_profile_identity BEFORE INSERT OR UPDATE OF email, phone ON public.profiles
FOR EACH ROW EXECUTE FUNCTION public.prevent_duplicate_profile_identity();

REVOKE ALL ON FUNCTION public.check_signup_availability(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.check_signup_availability(text, text) TO anon, authenticated;
