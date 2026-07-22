ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS street_address text,
  ADD COLUMN IF NOT EXISTS province text,
  ADD COLUMN IF NOT EXISTS postal_code text;

CREATE OR REPLACE FUNCTION public.update_profile_contact(
  p_phone text, p_street_address text, p_province text, p_postal_code text
)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_phone text := trim(COALESCE(p_phone,''));
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Unauthorized'; END IF;
  IF length(public.normalize_signup_phone(v_phone)) NOT BETWEEN 8 AND 15 THEN RAISE EXCEPTION 'Enter a valid phone number with 8 to 15 digits'; END IF;
  IF length(trim(COALESCE(p_street_address,''))) NOT BETWEEN 3 AND 150 THEN RAISE EXCEPTION 'Enter a valid street address'; END IF;
  IF length(trim(COALESCE(p_province,''))) NOT BETWEEN 2 AND 80 THEN RAISE EXCEPTION 'Enter a valid province'; END IF;
  IF trim(COALESCE(p_postal_code,'')) !~ '^[A-Za-z0-9 -]{3,10}$' THEN RAISE EXCEPTION 'Enter a valid postal code'; END IF;
  UPDATE public.profiles SET phone=v_phone, street_address=trim(p_street_address),
    province=trim(p_province), postal_code=upper(trim(p_postal_code)) WHERE id=auth.uid();
END;
$$;

REVOKE ALL ON FUNCTION public.update_profile_contact(text,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.update_profile_contact(text,text,text,text) TO authenticated;
