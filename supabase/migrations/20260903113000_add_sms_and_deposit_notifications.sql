-- Extend the existing durable financial-notification outbox. Email and SMS
-- have independent delivery state so one provider can retry without causing
-- duplicate messages through the other provider.
ALTER TABLE public.withdrawable_credit_email_queue
  ADD COLUMN IF NOT EXISTS recipient_phone text,
  ADD COLUMN IF NOT EXISTS notification_kind text NOT NULL DEFAULT 'withdrawable_credit',
  ADD COLUMN IF NOT EXISTS cycle_label text,
  ADD COLUMN IF NOT EXISTS maturity_date timestamptz,
  ADD COLUMN IF NOT EXISTS sms_status text,
  ADD COLUMN IF NOT EXISTS sms_attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS sms_next_attempt_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS sms_locked_at timestamptz,
  ADD COLUMN IF NOT EXISTS sms_sent_at timestamptz,
  ADD COLUMN IF NOT EXISTS sms_provider_message_id text,
  ADD COLUMN IF NOT EXISTS sms_last_error text;

-- Do not send old email events retroactively by SMS. Only events created after
-- this migration are eligible for SMS delivery.
UPDATE public.withdrawable_credit_email_queue q
SET recipient_phone = NULLIF(trim(p.phone), ''),
    sms_status = 'skipped'
FROM public.profiles p
WHERE p.id = q.user_id AND q.sms_status IS NULL;

UPDATE public.withdrawable_credit_email_queue
SET sms_status = 'skipped'
WHERE sms_status IS NULL;

ALTER TABLE public.withdrawable_credit_email_queue
  ALTER COLUMN sms_status SET DEFAULT 'pending',
  ALTER COLUMN sms_status SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.withdrawable_credit_email_queue'::regclass
      AND conname = 'withdrawable_credit_notification_kind_check'
  ) THEN
    ALTER TABLE public.withdrawable_credit_email_queue
      ADD CONSTRAINT withdrawable_credit_notification_kind_check
      CHECK (notification_kind IN ('withdrawable_credit', 'deposit_approved'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.withdrawable_credit_email_queue'::regclass
      AND conname = 'withdrawable_credit_sms_status_check'
  ) THEN
    ALTER TABLE public.withdrawable_credit_email_queue
      ADD CONSTRAINT withdrawable_credit_sms_status_check
      CHECK (sms_status IN ('pending', 'processing', 'sent', 'failed', 'skipped'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.withdrawable_credit_email_queue'::regclass
      AND conname = 'withdrawable_credit_sms_attempts_check'
  ) THEN
    ALTER TABLE public.withdrawable_credit_email_queue
      ADD CONSTRAINT withdrawable_credit_sms_attempts_check
      CHECK (sms_attempts >= 0);
  END IF;
END;
$$;

CREATE INDEX IF NOT EXISTS withdrawable_credit_sms_pending_idx
  ON public.withdrawable_credit_email_queue (sms_next_attempt_at, created_at)
  WHERE sms_status IN ('pending', 'processing');

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

-- Preserve the original helper for compatibility with already-deployed code.
CREATE OR REPLACE FUNCTION public.enqueue_withdrawable_credit_email(
  p_event_key text,
  p_user_id uuid,
  p_currency text,
  p_amount numeric,
  p_reason text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public.enqueue_fund_notification(
    p_event_key, p_user_id, p_currency, p_amount, p_reason,
    'withdrawable_credit', NULL, NULL
  );
END;
$$;

-- Queue deposit confirmation only after an administrator changes the deposit
-- from pending to completed. The deferred trigger sees the final verified
-- amount and the tranche/cycle created in the same approval transaction.
CREATE OR REPLACE FUNCTION public.queue_withdrawable_transaction_email()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tranche record;
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW.type = 'withdrawal'
     AND OLD.status = 'pending'
     AND NEW.status = 'failed' THEN
    PERFORM public.enqueue_fund_notification(
      'withdrawal-refund:' || NEW.id::text,
      NEW.user_id, NEW.currency, NEW.amount,
      'Failed withdrawal returned to withdrawable account'
    );
    RETURN NEW;
  END IF;

  IF NEW.status <> 'completed' OR NEW.type NOT IN ('bonus', 'deposit') THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' AND OLD.status = 'completed' THEN RETURN NEW; END IF;

  IF NEW.type = 'deposit' THEN
    -- An INSERT with completed status is not an administrator approval.
    IF TG_OP <> 'UPDATE' OR OLD.status <> 'pending' THEN RETURN NEW; END IF;

    SELECT t.cycle_label, t.maturity_date, t.status, t.approved
    INTO v_tranche
    FROM public.deposit_tranches t
    WHERE t.transaction_id = NEW.id
    ORDER BY t.created_at DESC
    LIMIT 1;

    IF FOUND AND v_tranche.approved = true AND v_tranche.status = 'locked' THEN
      PERFORM public.enqueue_fund_notification(
        'deposit-approved:' || NEW.id::text,
        NEW.user_id, NEW.currency, NEW.amount,
        'Deposit verified and approved', 'deposit_approved',
        v_tranche.cycle_label, v_tranche.maturity_date
      );
    END IF;
    RETURN NEW;
  END IF;

  -- Daily accrual and maturity ledger transactions are notified by the
  -- tranche-status trigger. Attached or locked bonuses do not notify early.
  IF COALESCE(NEW.reference, '') LIKE 'TRANCHE-%'
     OR COALESCE(NEW.reference, '') LIKE 'MATURITY-%' THEN
    RETURN NEW;
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.deposit_tranches t
    WHERE t.transaction_id = NEW.id AND t.status = 'locked' AND t.remaining > 0
  ) THEN
    RETURN NEW;
  END IF;

  PERFORM public.enqueue_fund_notification(
    'transaction-credit:' || NEW.id::text,
    NEW.user_id, NEW.currency, NEW.amount,
    COALESCE(NULLIF(trim(NEW.description), ''), 'Funds credited')
  );
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.queue_matured_tranche_email()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_gain numeric := 0;
BEGIN
  IF OLD.status = 'locked' AND NEW.status = 'matured' THEN
    SELECT COALESCE(s.gain, 0) INTO v_gain
    FROM public.tranche_maturity_settlements s
    WHERE s.tranche_id = NEW.id;

    PERFORM public.enqueue_fund_notification(
      'tranche-maturity:' || NEW.id::text,
      NEW.user_id, NEW.currency, NEW.remaining + COALESCE(v_gain, 0),
      'Growing cycle matured - principal and interest released',
      'withdrawable_credit', NEW.cycle_label, NEW.maturity_date
    );
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.claim_fund_notification_emails(p_limit integer DEFAULT 20)
RETURNS TABLE (
  notification_id uuid,
  recipient_email text,
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
  WITH candidates AS (
    SELECT q.id
    FROM public.withdrawable_credit_email_queue q
    WHERE (q.status = 'pending' AND q.next_attempt_at <= now())
       OR (q.status = 'processing' AND q.locked_at < now() - interval '10 minutes')
    ORDER BY q.created_at
    FOR UPDATE SKIP LOCKED
    LIMIT least(greatest(COALESCE(p_limit, 20), 1), 50)
  ), claimed AS (
    UPDATE public.withdrawable_credit_email_queue q
    SET status = 'processing', attempts = q.attempts + 1,
        locked_at = now(), last_error = NULL
    FROM candidates c
    WHERE q.id = c.id
    RETURNING q.*
  )
  SELECT c.id, c.recipient_email, c.recipient_name, c.currency, c.amount,
         c.reason, c.event_key, c.created_at, c.notification_kind,
         c.cycle_label, c.maturity_date
  FROM claimed c
  ORDER BY c.created_at;
$$;

CREATE OR REPLACE FUNCTION public.claim_fund_notification_sms(p_limit integer DEFAULT 20)
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
  WITH candidates AS (
    SELECT q.id
    FROM public.withdrawable_credit_email_queue q
    WHERE q.recipient_phone IS NOT NULL
      AND ((q.sms_status = 'pending' AND q.sms_next_attempt_at <= now())
        OR (q.sms_status = 'processing' AND q.sms_locked_at < now() - interval '10 minutes'))
    ORDER BY q.created_at
    FOR UPDATE SKIP LOCKED
    LIMIT least(greatest(COALESCE(p_limit, 20), 1), 50)
  ), claimed AS (
    UPDATE public.withdrawable_credit_email_queue q
    SET sms_status = 'processing', sms_attempts = q.sms_attempts + 1,
        sms_locked_at = now(), sms_last_error = NULL
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

CREATE OR REPLACE FUNCTION public.complete_fund_notification_sms(
  p_notification_id uuid,
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
  UPDATE public.withdrawable_credit_email_queue q
  SET sms_status = CASE
        WHEN p_success THEN 'sent'
        WHEN p_permanent_failure THEN 'failed'
        WHEN q.sms_attempts >= 8 THEN 'failed'
        ELSE 'pending'
      END,
      sms_sent_at = CASE WHEN p_success THEN now() ELSE NULL END,
      sms_provider_message_id = CASE
        WHEN p_success THEN left(COALESCE(p_provider_message_id, ''), 200)
        ELSE q.sms_provider_message_id
      END,
      sms_last_error = CASE
        WHEN p_success THEN NULL
        ELSE left(COALESCE(p_error, 'SMS delivery failed'), 500)
      END,
      sms_next_attempt_at = CASE
        WHEN p_success THEN q.sms_next_attempt_at
        ELSE now() + interval '5 minutes'
      END,
      sms_locked_at = NULL
  WHERE q.id = p_notification_id AND q.sms_status = 'processing';
END;
$$;

REVOKE ALL ON FUNCTION public.enqueue_fund_notification(text, uuid, text, numeric, text, text, text, timestamptz)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.claim_fund_notification_emails(integer)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.claim_fund_notification_sms(integer)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.complete_fund_notification_sms(uuid, boolean, text, text, boolean)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_fund_notification_emails(integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_fund_notification_sms(integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_fund_notification_sms(uuid, boolean, text, text, boolean) TO service_role;
