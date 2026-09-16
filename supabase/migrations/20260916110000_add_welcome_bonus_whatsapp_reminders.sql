ALTER TABLE public.welcome_bonus_sms_reminders
  ADD COLUMN IF NOT EXISTS whatsapp_status text NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS whatsapp_attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS whatsapp_locked_at timestamptz,
  ADD COLUMN IF NOT EXISTS whatsapp_sent_at timestamptz,
  ADD COLUMN IF NOT EXISTS whatsapp_provider_message_id text,
  ADD COLUMN IF NOT EXISTS whatsapp_error text;

ALTER TABLE public.welcome_bonus_sms_reminders
  ALTER COLUMN whatsapp_status SET DEFAULT 'pending';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.welcome_bonus_sms_reminders'::regclass
      AND conname = 'welcome_bonus_whatsapp_status_check'
  ) THEN
    ALTER TABLE public.welcome_bonus_sms_reminders
      ADD CONSTRAINT welcome_bonus_whatsapp_status_check
      CHECK (whatsapp_status IN ('pending', 'processing', 'sent', 'failed', 'skipped'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.welcome_bonus_sms_reminders'::regclass
      AND conname = 'welcome_bonus_whatsapp_attempts_check'
  ) THEN
    ALTER TABLE public.welcome_bonus_sms_reminders
      ADD CONSTRAINT welcome_bonus_whatsapp_attempts_check
      CHECK (whatsapp_attempts >= 0);
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.claim_welcome_bonus_whatsapp_reminder()
RETURNS SETOF public.welcome_bonus_sms_reminders
LANGUAGE sql SECURITY DEFINER SET search_path=public AS $$
  WITH candidates AS (
    SELECT r.id
    FROM public.welcome_bonus_sms_reminders r
    WHERE r.whatsapp_status = 'pending'
      AND r.recipient_phone <> ''
    ORDER BY r.attempted_at, r.id
    LIMIT 20
    FOR UPDATE SKIP LOCKED
  )
  UPDATE public.welcome_bonus_sms_reminders r
  SET whatsapp_status = 'processing', whatsapp_attempts = r.whatsapp_attempts + 1,
      whatsapp_locked_at = clock_timestamp(), whatsapp_error = NULL
  FROM candidates c
  WHERE r.id = c.id
  RETURNING r.*;
$$;

CREATE OR REPLACE FUNCTION public.complete_welcome_bonus_whatsapp_reminder(
  p_id uuid,
  p_success boolean,
  p_provider_message_id text DEFAULT NULL,
  p_error text DEFAULT NULL
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
  UPDATE public.welcome_bonus_sms_reminders r
  SET whatsapp_status = CASE
        WHEN p_success THEN 'sent'
        WHEN r.whatsapp_attempts >= 8 THEN 'failed'
        ELSE 'pending'
      END,
      whatsapp_sent_at = CASE WHEN p_success THEN clock_timestamp() ELSE NULL END,
      whatsapp_provider_message_id = CASE
        WHEN p_success THEN left(p_provider_message_id, 200)
        ELSE r.whatsapp_provider_message_id
      END,
      whatsapp_error = CASE
        WHEN p_success THEN NULL
        ELSE left(COALESCE(p_error, 'WhatsApp delivery failed'), 500)
      END,
      whatsapp_locked_at = NULL
  WHERE r.id = p_id AND r.whatsapp_status = 'processing';
END;
$$;

REVOKE ALL ON FUNCTION public.claim_welcome_bonus_whatsapp_reminder() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.complete_welcome_bonus_whatsapp_reminder(uuid, boolean, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_welcome_bonus_whatsapp_reminder() TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_welcome_bonus_whatsapp_reminder(uuid, boolean, text, text) TO service_role;