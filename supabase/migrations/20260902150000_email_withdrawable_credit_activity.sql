-- Financial transactions must never fail because an email provider is slow or
-- unavailable. Commit a durable outbox row with the money event, then let an
-- independent worker deliver it with retries and provider idempotency.
CREATE TABLE IF NOT EXISTS public.withdrawable_credit_email_queue (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_key text NOT NULL UNIQUE CHECK (length(event_key) BETWEEN 3 AND 200),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  recipient_email text NOT NULL CHECK (length(recipient_email) BETWEEN 3 AND 320),
  recipient_name text,
  currency text NOT NULL CHECK (currency IN ('ZAR', 'USD')),
  amount numeric(18,2) NOT NULL CHECK (amount > 0),
  reason text NOT NULL CHECK (length(reason) BETWEEN 3 AND 300),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'sent', 'failed')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz,
  sent_at timestamptz,
  provider_message_id text,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS withdrawable_credit_email_pending_idx
  ON public.withdrawable_credit_email_queue (next_attempt_at, created_at)
  WHERE status IN ('pending', 'processing');

ALTER TABLE public.withdrawable_credit_email_queue ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.withdrawable_credit_email_queue FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.withdrawable_credit_email_queue TO service_role;

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
DECLARE
  v_email text;
  v_name text;
  v_amount numeric := round(p_amount, 2);
BEGIN
  IF p_currency NOT IN ('ZAR', 'USD') OR v_amount < 0.01 THEN RETURN; END IF;

  SELECT lower(trim(u.email)), NULLIF(trim(p.first_name), '')
  INTO v_email, v_name
  FROM auth.users u
  LEFT JOIN public.profiles p ON p.id = u.id
  WHERE u.id = p_user_id;

  IF v_email IS NULL OR length(v_email) < 3 THEN RETURN; END IF;

  INSERT INTO public.withdrawable_credit_email_queue (
    event_key, user_id, recipient_email, recipient_name, currency, amount, reason
  ) VALUES (
    left(p_event_key, 200), p_user_id, v_email, v_name, p_currency, v_amount,
    left(COALESCE(NULLIF(trim(p_reason), ''), 'Funds credited'), 300)
  )
  ON CONFLICT (event_key) DO NOTHING;
END;
$$;

-- Completed credit transactions are evaluated at commit time so a tranche
-- inserted later in the same transaction is visible. Locked deposits, welcome
-- bonuses, attached admin credits, and daily accruals do not email early.
CREATE OR REPLACE FUNCTION public.queue_withdrawable_transaction_email()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW.type = 'withdrawal'
     AND OLD.status = 'pending'
     AND NEW.status = 'failed' THEN
    PERFORM public.enqueue_withdrawable_credit_email(
      'withdrawal-refund:' || NEW.id::text,
      NEW.user_id,
      NEW.currency,
      NEW.amount,
      'Failed withdrawal returned to withdrawable account'
    );
    RETURN NEW;
  END IF;

  IF NEW.status <> 'completed' OR NEW.type NOT IN ('bonus', 'deposit') THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' AND OLD.status = 'completed' THEN RETURN NEW; END IF;

  -- Daily accrual is still growing, while maturity is notified once with the
  -- principal and full interest by the tranche-status trigger below.
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

  PERFORM public.enqueue_withdrawable_credit_email(
    'transaction-credit:' || NEW.id::text,
    NEW.user_id,
    NEW.currency,
    NEW.amount,
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

    PERFORM public.enqueue_withdrawable_credit_email(
      'tranche-maturity:' || NEW.id::text,
      NEW.user_id,
      NEW.currency,
      NEW.remaining + COALESCE(v_gain, 0),
      'Growing cycle matured - principal and interest released'
    );
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS queue_withdrawable_transaction_insert_email ON public.transactions;
CREATE CONSTRAINT TRIGGER queue_withdrawable_transaction_insert_email
AFTER INSERT ON public.transactions
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION public.queue_withdrawable_transaction_email();

DROP TRIGGER IF EXISTS queue_withdrawable_transaction_update_email ON public.transactions;
CREATE CONSTRAINT TRIGGER queue_withdrawable_transaction_update_email
AFTER UPDATE OF status ON public.transactions
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION public.queue_withdrawable_transaction_email();

DROP TRIGGER IF EXISTS queue_matured_tranche_email ON public.deposit_tranches;
CREATE CONSTRAINT TRIGGER queue_matured_tranche_email
AFTER UPDATE OF status ON public.deposit_tranches
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION public.queue_matured_tranche_email();

-- Claim rows atomically so overlapping cron invocations cannot send the same
-- queue item concurrently. A stale processing claim is recoverable.
CREATE OR REPLACE FUNCTION public.claim_withdrawable_credit_emails(p_limit integer DEFAULT 20)
RETURNS TABLE (
  notification_id uuid,
  recipient_email text,
  recipient_name text,
  currency text,
  amount numeric,
  reason text,
  event_key text,
  event_created_at timestamptz
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  WITH candidates AS (
    SELECT q.id
    FROM public.withdrawable_credit_email_queue q
    WHERE (
      q.status = 'pending' AND q.next_attempt_at <= now()
    ) OR (
      q.status = 'processing' AND q.locked_at < now() - interval '10 minutes'
    )
    ORDER BY q.created_at
    FOR UPDATE SKIP LOCKED
    LIMIT least(greatest(COALESCE(p_limit, 20), 1), 50)
  ), claimed AS (
    UPDATE public.withdrawable_credit_email_queue q
    SET status = 'processing',
        attempts = q.attempts + 1,
        locked_at = now(),
        last_error = NULL
    FROM candidates c
    WHERE q.id = c.id
    RETURNING q.*
  )
  SELECT c.id, c.recipient_email, c.recipient_name, c.currency, c.amount,
         c.reason, c.event_key, c.created_at
  FROM claimed c
  ORDER BY c.created_at;
$$;

CREATE OR REPLACE FUNCTION public.complete_withdrawable_credit_email(
  p_notification_id uuid,
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
  UPDATE public.withdrawable_credit_email_queue q
  SET status = CASE
        WHEN p_success THEN 'sent'
        WHEN q.attempts >= 8 THEN 'failed'
        ELSE 'pending'
      END,
      sent_at = CASE WHEN p_success THEN now() ELSE NULL END,
      provider_message_id = CASE
        WHEN p_success THEN left(COALESCE(p_provider_message_id, ''), 200)
        ELSE q.provider_message_id
      END,
      last_error = CASE WHEN p_success THEN NULL ELSE left(COALESCE(p_error, 'Email delivery failed'), 500) END,
      next_attempt_at = CASE WHEN p_success THEN q.next_attempt_at ELSE now() + interval '5 minutes' END,
      locked_at = NULL
  WHERE q.id = p_notification_id AND q.status = 'processing';
END;
$$;

REVOKE ALL ON FUNCTION public.enqueue_withdrawable_credit_email(text, uuid, text, numeric, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.queue_withdrawable_transaction_email() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.queue_matured_tranche_email() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.claim_withdrawable_credit_emails(integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.complete_withdrawable_credit_email(uuid, boolean, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_withdrawable_credit_emails(integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_withdrawable_credit_email(uuid, boolean, text, text) TO service_role;

-- The app now uses only request-keyed financial functions. Prevent older RPCs
-- from bypassing retry protection while retaining them for migration history.
REVOKE EXECUTE ON FUNCTION public.request_withdrawal_secure(numeric, text, text, text, boolean) FROM authenticated;
REVOKE EXECUTE ON FUNCTION public.move_withdrawable_to_growing_secure(numeric, text) FROM authenticated;
REVOKE EXECUTE ON FUNCTION public.admin_credit_bonus_secure(uuid, text, numeric, text, text, uuid) FROM authenticated;

CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;

DO $$
DECLARE existing_job bigint;
BEGIN
  FOR existing_job IN
    SELECT jobid FROM cron.job WHERE jobname = 'withdrawable-credit-email-every-minute'
  LOOP
    PERFORM cron.unschedule(existing_job);
  END LOOP;

  PERFORM cron.schedule(
    'withdrawable-credit-email-every-minute',
    '* * * * *',
    $job$
      SELECT net.http_post(
        url := 'https://jrqrpjdlhzzfanqwinct.supabase.co/functions/v1/withdrawable-credit-email',
        headers := '{"Content-Type":"application/json"}'::jsonb,
        body := '{}'::jsonb,
        timeout_milliseconds := 30000
      );
    $job$
  );
END;
$$;
