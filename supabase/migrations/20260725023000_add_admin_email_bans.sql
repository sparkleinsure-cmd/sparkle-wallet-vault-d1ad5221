-- A deletion ban applies only to the exact normalized email address. It is
-- deliberately separate from welcome-bonus risk signals such as phone,
-- installation, system fingerprint, and network.
CREATE TABLE IF NOT EXISTS public.admin_banned_emails (
  email text PRIMARY KEY CHECK (email = lower(trim(email)) AND length(email) BETWEEN 3 AND 320),
  banned_user_id uuid NOT NULL,
  banned_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  banned_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.admin_banned_emails ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.admin_banned_emails FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.admin_banned_emails TO service_role;

CREATE OR REPLACE FUNCTION public.reject_admin_banned_email_signup()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.admin_banned_emails
    WHERE email = lower(trim(COALESCE(NEW.email, '')))
  ) THEN
    RAISE EXCEPTION 'This email address is permanently banned from registration';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS reject_admin_banned_email_signup ON auth.users;
CREATE TRIGGER reject_admin_banned_email_signup
BEFORE INSERT OR UPDATE OF email ON auth.users
FOR EACH ROW EXECUTE FUNCTION public.reject_admin_banned_email_signup();

-- Keep the public preflight used by the signup form useful, while the auth.users
-- trigger above remains the authoritative protection against direct API calls.
CREATE OR REPLACE FUNCTION public.check_signup_availability(p_email text, p_phone text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_email text := lower(trim(COALESCE(p_email, '')));
  v_phone text := public.normalize_signup_phone(p_phone);
BEGIN
  RETURN jsonb_build_object(
    'emailExists',
      EXISTS (SELECT 1 FROM public.profiles WHERE lower(email) = v_email)
      OR EXISTS (SELECT 1 FROM public.admin_banned_emails WHERE email = v_email),
    'phoneExists',
      EXISTS (
        SELECT 1 FROM public.profiles
        WHERE public.normalize_signup_phone(phone) = v_phone
          AND length(v_phone) BETWEEN 8 AND 15
      )
  );
END;
$$;

REVOKE ALL ON FUNCTION public.reject_admin_banned_email_signup() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.check_signup_availability(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.check_signup_availability(text, text) TO anon, authenticated;
