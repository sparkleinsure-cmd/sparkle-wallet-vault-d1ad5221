-- Undo September 16 reminder and WhatsApp features; preserve existing email/SMS.
CREATE OR REPLACE FUNCTION public.enqueue_fund_notification(
  p_event_key text,
  p_user_id uuid,
  p_currency text,
  p_amount numeric,
  p_reason text,
  p_notification_kind text DEFAULT 'withdrawable_credit',
  p_cycle_label text DEFAULT NULL,
  p_maturity_date timestamptz DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_email text;
  v_name text;
  v_phone text;
  v_amount numeric := round(p_amount, 2);
  v_sms_status text;
BEGIN
  IF p_currency NOT IN ('ZAR', 'USD')
     OR v_amount < 0.01
     OR p_notification_kind NOT IN ('withdrawable_credit', 'deposit_approved') THEN
    RETURN;
  END IF;

  SELECT lower(trim(u.email)), NULLIF(trim(p.first_name), ''), NULLIF(trim(p.phone), '')
  INTO v_email, v_name, v_phone
  FROM auth.users u
  LEFT JOIN public.profiles p ON p.id = u.id
  WHERE u.id = p_user_id;

  IF v_email IS NULL OR length(v_email) < 3 THEN RETURN; END IF;
  v_sms_status := CASE WHEN length(COALESCE(v_phone, '')) >= 8 THEN 'pending' ELSE 'skipped' END;

  INSERT INTO public.withdrawable_credit_email_queue (
    event_key, user_id, recipient_email, recipient_name, recipient_phone,
    currency, amount, reason, notification_kind, cycle_label, maturity_date,
    next_attempt_at, sms_status, sms_next_attempt_at
  ) VALUES (
    left(p_event_key, 200), p_user_id, v_email, v_name, v_phone,
    p_currency, v_amount,
    left(COALESCE(NULLIF(trim(p_reason), ''), 'Funds credited'), 300),
    p_notification_kind, NULLIF(left(trim(COALESCE(p_cycle_label, '')), 100), ''),
    p_maturity_date, now() + interval '30 seconds', v_sms_status,
    now() + interval '30 seconds'
  )
  ON CONFLICT (event_key) DO NOTHING;
END;
$$;

DROP TRIGGER IF EXISTS enqueue_welcome_note_whatsapp ON auth.users;
DROP TRIGGER IF EXISTS track_welcome_bonus_sms_activity ON public.user_presence;
DROP FUNCTION IF EXISTS public.enqueue_welcome_note_whatsapp();
DROP FUNCTION IF EXISTS public.claim_welcome_note_whatsapp(text);
DROP FUNCTION IF EXISTS public.complete_welcome_note_whatsapp(uuid, boolean, text, text);
DROP FUNCTION IF EXISTS public.track_welcome_bonus_sms_activity();
DROP FUNCTION IF EXISTS public.admin_welcome_bonus_sms_report(integer);
DROP FUNCTION IF EXISTS public.complete_welcome_bonus_sms_reminder(uuid, text, text, text);
DROP FUNCTION IF EXISTS public.claim_welcome_bonus_sms_reminder();
DROP FUNCTION IF EXISTS public.complete_welcome_bonus_whatsapp_reminder(uuid, boolean, text, text);
DROP FUNCTION IF EXISTS public.claim_welcome_bonus_whatsapp_reminder();
DROP FUNCTION IF EXISTS public.claim_welcome_bonus_whatsapp_reminder(text);
DROP FUNCTION IF EXISTS public.claim_fund_notification_whatsapp(integer);
DROP FUNCTION IF EXISTS public.claim_fund_notification_whatsapp(integer, text);
DROP FUNCTION IF EXISTS public.complete_fund_notification_whatsapp(uuid, boolean, text, text, boolean);
DROP TABLE IF EXISTS public.welcome_note_whatsapp_queue;
DROP TABLE IF EXISTS public.welcome_bonus_sms_reminders;

ALTER TABLE public.withdrawable_credit_email_queue
  DROP COLUMN IF EXISTS whatsapp_status,
  DROP COLUMN IF EXISTS whatsapp_attempts,
  DROP COLUMN IF EXISTS whatsapp_next_attempt_at,
  DROP COLUMN IF EXISTS whatsapp_locked_at,
  DROP COLUMN IF EXISTS whatsapp_sent_at,
  DROP COLUMN IF EXISTS whatsapp_provider_message_id,
  DROP COLUMN IF EXISTS whatsapp_last_error;
