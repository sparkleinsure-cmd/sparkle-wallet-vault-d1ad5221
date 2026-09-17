-- Add automated 2-day welcome bonus reminder via Email and SMS.
CREATE TABLE IF NOT EXISTS public.welcome_bonus_unclaimed_reminders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  recipient_email text NOT NULL,
  recipient_name text,
  recipient_phone text,
  email_status text NOT NULL DEFAULT 'pending' CHECK (email_status IN ('pending', 'processing', 'sent', 'failed', 'skipped')),
  email_attempts integer NOT NULL DEFAULT 0 CHECK (email_attempts >= 0),
  email_next_attempt_at timestamptz NOT NULL DEFAULT now(),
  email_locked_at timestamptz,
  email_sent_at timestamptz,
  email_provider_message_id text,
  email_last_error text,
  sms_status text NOT NULL DEFAULT 'pending' CHECK (sms_status IN ('pending', 'processing', 'sent', 'failed', 'skipped')),
  sms_attempts integer NOT NULL DEFAULT 0 CHECK (sms_attempts >= 0),
  sms_next_attempt_at timestamptz NOT NULL DEFAULT now(),
  sms_locked_at timestamptz,
  sms_sent_at timestamptz,
  sms_provider_message_id text,
  sms_last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT welcome_bonus_unclaimed_reminders_user_unique UNIQUE (user_id)
);

ALTER TABLE public.welcome_bonus_unclaimed_reminders ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.welcome_bonus_unclaimed_reminders FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.welcome_bonus_unclaimed_reminders TO service_role;

CREATE INDEX IF NOT EXISTS welcome_bonus_unclaimed_email_pending_idx
  ON public.welcome_bonus_unclaimed_reminders (email_next_attempt_at, created_at)
  WHERE email_status IN ('pending', 'processing');

CREATE INDEX IF NOT EXISTS welcome_bonus_unclaimed_sms_pending_idx
  ON public.welcome_bonus_unclaimed_reminders (sms_next_attempt_at, created_at)
  WHERE sms_status IN ('pending', 'processing');

-- Function to scan and enqueue users whose accounts are >= 2 days old and haven't claimed the R10 bonus
CREATE OR REPLACE FUNCTION public.enqueue_overdue_welcome_bonus_reminders()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_inserted integer := 0;
BEGIN
  WITH candidates AS (
    SELECT
      p.id AS user_id,
      lower(trim(p.email)) AS recipient_email,
      NULLIF(trim(p.first_name), '') AS recipient_name,
      NULLIF(trim(p.phone), '') AS recipient_phone
    FROM public.profiles p
    WHERE p.welcome_bonus_credited_at IS NULL
      AND p.created_at <= now() - interval '2 days'
      AND length(trim(p.email)) >= 3
      AND NOT EXISTS (
        SELECT 1 FROM public.welcome_bonus_unclaimed_reminders r
        WHERE r.user_id = p.id
      )
  ),
  ins AS (
    INSERT INTO public.welcome_bonus_unclaimed_reminders (
      user_id, recipient_email, recipient_name, recipient_phone,
      email_status, email_next_attempt_at,
      sms_status, sms_next_attempt_at
    )
    SELECT
      c.user_id,
      c.recipient_email,
      c.recipient_name,
      c.recipient_phone,
      'pending',
      now(),
      CASE WHEN length(COALESCE(c.recipient_phone, '')) >= 8 THEN 'pending' ELSE 'skipped' END,
      now()
    FROM candidates c
    ON CONFLICT (user_id) DO NOTHING
    RETURNING id
  )
  SELECT count(*) INTO v_inserted FROM ins;

  RETURN v_inserted;
END;
$$;

-- Claim unclaimed email reminders
CREATE OR REPLACE FUNCTION public.claim_unclaimed_bonus_emails(p_limit integer DEFAULT 20)
RETURNS TABLE (
  reminder_id uuid,
  recipient_email text,
  recipient_name text
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  WITH candidates AS (
    SELECT r.id
    FROM public.welcome_bonus_unclaimed_reminders r
    JOIN public.profiles p ON p.id = r.user_id
    WHERE p.welcome_bonus_credited_at IS NULL
      AND ((r.email_status = 'pending' AND r.email_next_attempt_at <= now())
        OR (r.email_status = 'processing' AND r.email_locked_at < now() - interval '10 minutes'))
    ORDER BY r.created_at
    FOR UPDATE SKIP LOCKED
    LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 20), 100))
  ), claimed AS (
    UPDATE public.welcome_bonus_unclaimed_reminders r
    SET email_status = 'processing',
        email_attempts = r.email_attempts + 1,
        email_locked_at = now(),
        email_last_error = NULL
    FROM candidates c
    WHERE r.id = c.id
    RETURNING r.id, r.recipient_email, r.recipient_name
  )
  SELECT c.id, c.recipient_email, c.recipient_name FROM claimed c;
$$;

-- Complete unclaimed email reminder
CREATE OR REPLACE FUNCTION public.complete_unclaimed_bonus_email(
  p_reminder_id uuid,
  p_success boolean,
  p_provider_message_id text DEFAULT NULL,
  p_error text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.welcome_bonus_unclaimed_reminders r
  SET email_status = CASE
        WHEN p_success THEN 'sent'
        WHEN r.email_attempts >= 8 THEN 'failed'
        ELSE 'pending'
      END,
      email_sent_at = CASE WHEN p_success THEN now() ELSE NULL END,
      email_provider_message_id = CASE
        WHEN p_success THEN left(COALESCE(p_provider_message_id, ''), 200)
        ELSE r.email_provider_message_id
      END,
      email_last_error = CASE
        WHEN p_success THEN NULL
        ELSE left(COALESCE(p_error, 'Email delivery failed'), 500)
      END,
      email_next_attempt_at = CASE
        WHEN p_success THEN r.email_next_attempt_at
        ELSE now() + interval '5 minutes'
      END,
      email_locked_at = NULL
  WHERE r.id = p_reminder_id AND r.email_status = 'processing';
END;
$$;

-- Claim unclaimed SMS reminders
CREATE OR REPLACE FUNCTION public.claim_unclaimed_bonus_sms(p_limit integer DEFAULT 20)
RETURNS TABLE (
  reminder_id uuid,
  recipient_phone text,
  recipient_name text
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  WITH candidates AS (
    SELECT r.id
    FROM public.welcome_bonus_unclaimed_reminders r
    JOIN public.profiles p ON p.id = r.user_id
    WHERE p.welcome_bonus_credited_at IS NULL
      AND r.recipient_phone IS NOT NULL
      AND ((r.sms_status = 'pending' AND r.sms_next_attempt_at <= now())
        OR (r.sms_status = 'processing' AND r.sms_locked_at < now() - interval '10 minutes'))
    ORDER BY r.created_at
    FOR UPDATE SKIP LOCKED
    LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 20), 100))
  ), claimed AS (
    UPDATE public.welcome_bonus_unclaimed_reminders r
    SET sms_status = 'processing',
        sms_attempts = r.sms_attempts + 1,
        sms_locked_at = now(),
        sms_last_error = NULL
    FROM candidates c
    WHERE r.id = c.id
    RETURNING r.id, r.recipient_phone, r.recipient_name
  )
  SELECT c.id, c.recipient_phone, c.recipient_name FROM claimed c;
$$;

-- Complete unclaimed SMS reminder
CREATE OR REPLACE FUNCTION public.complete_unclaimed_bonus_sms(
  p_reminder_id uuid,
  p_success boolean,
  p_provider_message_id text DEFAULT NULL,
  p_error text DEFAULT NULL,
  p_permanent_failure boolean DEFAULT false
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.welcome_bonus_unclaimed_reminders r
  SET sms_status = CASE
        WHEN p_success THEN 'sent'
        WHEN p_permanent_failure THEN 'failed'
        WHEN r.sms_attempts >= 8 THEN 'failed'
        ELSE 'pending'
      END,
      sms_sent_at = CASE WHEN p_success THEN now() ELSE NULL END,
      sms_provider_message_id = CASE
        WHEN p_success THEN left(COALESCE(p_provider_message_id, ''), 200)
        ELSE r.sms_provider_message_id
      END,
      sms_last_error = CASE
        WHEN p_success THEN NULL
        ELSE left(COALESCE(p_error, 'SMS delivery failed'), 500)
      END,
      sms_next_attempt_at = CASE
        WHEN p_success THEN r.sms_next_attempt_at
        ELSE now() + interval '5 minutes'
      END,
      sms_locked_at = NULL
  WHERE r.id = p_reminder_id AND r.sms_status = 'processing';
END;
$$;

REVOKE ALL ON FUNCTION public.enqueue_overdue_welcome_bonus_reminders() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.claim_unclaimed_bonus_emails(integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.complete_unclaimed_bonus_email(uuid, boolean, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.claim_unclaimed_bonus_sms(integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.complete_unclaimed_bonus_sms(uuid, boolean, text, text, boolean) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.enqueue_overdue_welcome_bonus_reminders() TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_unclaimed_bonus_emails(integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_unclaimed_bonus_email(uuid, boolean, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_unclaimed_bonus_sms(integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_unclaimed_bonus_sms(uuid, boolean, text, text, boolean) TO service_role;
