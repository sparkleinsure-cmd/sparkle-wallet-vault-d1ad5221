CREATE OR REPLACE FUNCTION public.claim_fund_notification_whatsapp(
  p_limit integer DEFAULT 20,
  p_recipient_phone text DEFAULT NULL
)
RETURNS TABLE (
  notification_id uuid,
  recipient_phone text,
  recipient_name text,
  currency text,
  amount numeric,
  reason text,
  event_key text,
  event_created_at timestamptz,
  notification_kind text,
  cycle_label text,
  maturity_date timestamptz
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  WITH target AS (
    SELECT regexp_replace(
      regexp_replace(regexp_replace(COALESCE(p_recipient_phone, ''), '\D', '', 'g'), '^00', ''),
      '^0', '27'
    ) AS phone
  ), candidates AS (
    SELECT q.id
    FROM public.withdrawable_credit_email_queue q, target t
    WHERE t.phone <> ''
      AND regexp_replace(
        regexp_replace(regexp_replace(COALESCE(q.recipient_phone, ''), '\D', '', 'g'), '^00', ''),
        '^0', '27'
      ) = t.phone
      AND q.whatsapp_status IN ('pending', 'skipped')
      AND q.whatsapp_sent_at IS NULL
    ORDER BY q.created_at
    FOR UPDATE SKIP LOCKED
    LIMIT least(greatest(COALESCE(p_limit, 20), 1), 50)
  ), claimed AS (
    UPDATE public.withdrawable_credit_email_queue q
    SET whatsapp_status = 'processing', whatsapp_attempts = q.whatsapp_attempts + 1,
        whatsapp_locked_at = now(), whatsapp_last_error = NULL
    FROM candidates c
    WHERE q.id = c.id
    RETURNING q.*
  )
  SELECT c.id, c.recipient_phone, c.recipient_name, c.currency, c.amount,
         c.reason, c.event_key, c.created_at, c.notification_kind,
         c.cycle_label, c.maturity_date
  FROM claimed c
  ORDER BY c.created_at;
$$;

CREATE OR REPLACE FUNCTION public.claim_welcome_bonus_whatsapp_reminder(
  p_recipient_phone text DEFAULT NULL
)
RETURNS SETOF public.welcome_bonus_sms_reminders
LANGUAGE sql SECURITY DEFINER SET search_path=public AS $$
  WITH target AS (
    SELECT regexp_replace(
      regexp_replace(regexp_replace(COALESCE(p_recipient_phone, ''), '\D', '', 'g'), '^00', ''),
      '^0', '27'
    ) AS phone
  ), candidates AS (
    SELECT r.id
    FROM public.welcome_bonus_sms_reminders r, target t
    WHERE t.phone <> ''
      AND regexp_replace(
        regexp_replace(regexp_replace(COALESCE(r.recipient_phone, ''), '\D', '', 'g'), '^00', ''),
        '^0', '27'
      ) = t.phone
      AND r.whatsapp_status IN ('pending', 'skipped')
      AND r.whatsapp_sent_at IS NULL
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