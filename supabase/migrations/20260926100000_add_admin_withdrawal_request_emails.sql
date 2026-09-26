-- Isolated admin withdrawal alerts. No historical requests are backfilled.
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;

CREATE TABLE IF NOT EXISTS public.admin_withdrawal_request_email_queue (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id uuid NOT NULL UNIQUE
    REFERENCES public.transactions(id) ON DELETE CASCADE,
  account_id text,
  user_name text,
  bank_name text,
  bank_account_number text,
  currency text NOT NULL,
  amount numeric NOT NULL,
  submitted_at timestamptz NOT NULL,
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

CREATE INDEX IF NOT EXISTS admin_withdrawal_request_email_pending_idx
  ON public.admin_withdrawal_request_email_queue (next_attempt_at, created_at)
  WHERE status IN ('pending', 'processing');

ALTER TABLE public.admin_withdrawal_request_email_queue ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.admin_withdrawal_request_email_queue FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.admin_withdrawal_request_email_queue TO service_role;

CREATE OR REPLACE FUNCTION public.queue_admin_withdrawal_request_email()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.type = 'withdrawal' AND NEW.status = 'pending' THEN
    INSERT INTO public.admin_withdrawal_request_email_queue (
      transaction_id, account_id, user_name, bank_name, bank_account_number,
      currency, amount, submitted_at
    )
    SELECT NEW.id, p.account_id, concat_ws(' ', p.first_name, p.surname),
      p.bank_name, p.bank_account_number, NEW.currency, NEW.amount, NEW.created_at
    FROM public.profiles p WHERE p.id = NEW.user_id
    ON CONFLICT ON CONSTRAINT admin_withdrawal_request_email_queue_transaction_id_key
    DO NOTHING;

    -- pg_net dispatches after the database transaction commits. The minute
    -- cron below is a fallback if this immediate request cannot be delivered.
    IF FOUND THEN
      BEGIN
        PERFORM net.http_post(
          url := 'https://jrqrpjdlhzzfanqwinct.supabase.co/functions/v1/admin-withdrawal-request-email',
          headers := '{"Content-Type":"application/json"}'::jsonb,
          body := '{}'::jsonb,
          timeout_milliseconds := 30000
        );
      EXCEPTION WHEN OTHERS THEN
        -- The durable queue and cron retry survive an unavailable dispatcher.
        NULL;
      END;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS queue_admin_withdrawal_request_email ON public.transactions;
CREATE TRIGGER queue_admin_withdrawal_request_email
AFTER INSERT ON public.transactions
FOR EACH ROW EXECUTE FUNCTION public.queue_admin_withdrawal_request_email();

-- Claim requests atomically; preserve the original request details for retries.
CREATE OR REPLACE FUNCTION public.claim_admin_withdrawal_request_emails(
  p_limit integer DEFAULT 20
)
RETURNS TABLE (
  notification_id uuid,
  transaction_id uuid,
  account_id text,
  user_name text,
  bank_name text,
  bank_account_number text,
  currency text,
  amount numeric,
  submitted_at timestamptz
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  WITH candidates AS (
    SELECT q.id
    FROM public.admin_withdrawal_request_email_queue q
    WHERE (
        (q.status = 'pending' AND q.next_attempt_at <= now())
        OR (q.status = 'processing' AND q.locked_at < now() - interval '10 minutes')
      )
    ORDER BY q.created_at
    FOR UPDATE OF q SKIP LOCKED
    LIMIT least(greatest(COALESCE(p_limit, 20), 1), 50)
  ), claimed AS (
    UPDATE public.admin_withdrawal_request_email_queue q
    SET status = 'processing',
        attempts = q.attempts + 1,
        locked_at = now(),
        last_error = NULL
    FROM candidates c
    WHERE q.id = c.id
    RETURNING q.*
  )
  SELECT c.id, c.transaction_id, c.account_id, c.user_name,
    c.bank_name, c.bank_account_number, c.currency, c.amount, c.submitted_at
  FROM claimed c ORDER BY c.created_at;
$$;

CREATE OR REPLACE FUNCTION public.complete_admin_withdrawal_request_email(
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
  UPDATE public.admin_withdrawal_request_email_queue q
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
      last_error = CASE
        WHEN p_success THEN NULL
        ELSE left(COALESCE(p_error, 'Admin withdrawal alert delivery failed'), 500)
      END,
      next_attempt_at = CASE
        WHEN p_success THEN q.next_attempt_at
        ELSE now() + interval '5 minutes'
      END,
      locked_at = NULL
  WHERE q.id = p_notification_id
    AND q.status = 'processing';
END;
$$;

REVOKE ALL ON FUNCTION public.queue_admin_withdrawal_request_email()
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.claim_admin_withdrawal_request_emails(integer)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.complete_admin_withdrawal_request_email(uuid, boolean, text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_admin_withdrawal_request_emails(integer)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_admin_withdrawal_request_email(uuid, boolean, text, text)
  TO service_role;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'admin-withdrawal-request-email-every-minute') THEN
    PERFORM cron.schedule(
      'admin-withdrawal-request-email-every-minute', '* * * * *',
      $job$SELECT net.http_post(
        url := 'https://jrqrpjdlhzzfanqwinct.supabase.co/functions/v1/admin-withdrawal-request-email',
        headers := '{"Content-Type":"application/json"}'::jsonb,
        body := '{}'::jsonb, timeout_milliseconds := 30000
      );$job$
    );
  END IF;
END;
$$;
