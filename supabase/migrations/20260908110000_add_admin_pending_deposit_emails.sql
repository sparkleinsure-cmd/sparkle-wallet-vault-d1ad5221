-- Notify the administrator after a member has successfully submitted a
-- pending deposit with proof of payment. The durable queue keeps the deposit
-- submission independent of the email provider and prevents duplicate alerts.
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;

CREATE TABLE IF NOT EXISTS public.admin_pending_deposit_email_queue (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id uuid NOT NULL UNIQUE
    REFERENCES public.transactions(id) ON DELETE CASCADE,
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

CREATE INDEX IF NOT EXISTS admin_pending_deposit_email_pending_idx
  ON public.admin_pending_deposit_email_queue (next_attempt_at, created_at)
  WHERE status IN ('pending', 'processing');

ALTER TABLE public.admin_pending_deposit_email_queue ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.admin_pending_deposit_email_queue FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.admin_pending_deposit_email_queue TO service_role;

CREATE OR REPLACE FUNCTION public.queue_admin_pending_deposit_email()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.type = 'deposit'
     AND NEW.status = 'pending'
     AND NULLIF(trim(COALESCE(NEW.proof_url, '')), '') IS NOT NULL THEN
    INSERT INTO public.admin_pending_deposit_email_queue (transaction_id)
    VALUES (NEW.id)
    ON CONFLICT ON CONSTRAINT admin_pending_deposit_email_queue_transaction_id_key
    DO NOTHING;

    -- pg_net dispatches after the database transaction commits. The minute
    -- cron below is a fallback if this immediate request cannot be delivered.
    IF FOUND THEN
      PERFORM net.http_post(
        url := 'https://jrqrpjdlhzzfanqwinct.supabase.co/functions/v1/admin-maturity-alert-email',
        headers := '{"Content-Type":"application/json"}'::jsonb,
        body := '{"kind":"deposit"}'::jsonb,
        timeout_milliseconds := 30000
      );
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS queue_admin_pending_deposit_email ON public.transactions;
CREATE TRIGGER queue_admin_pending_deposit_email
AFTER INSERT ON public.transactions
FOR EACH ROW EXECUTE FUNCTION public.queue_admin_pending_deposit_email();

-- Claim work atomically. Only deposits that are still pending are emailed, so
-- an already-reviewed deposit can never produce a stale approval request.
CREATE OR REPLACE FUNCTION public.claim_admin_pending_deposit_emails(
  p_limit integer DEFAULT 20
)
RETURNS TABLE (
  notification_id uuid,
  transaction_id uuid,
  account_id text,
  user_name text,
  user_email text,
  user_phone text,
  currency text,
  amount numeric,
  deposit_reference text,
  cycle_label text,
  proof_path text,
  submitted_at timestamptz
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  WITH candidates AS (
    SELECT q.id
    FROM public.admin_pending_deposit_email_queue q
    JOIN public.transactions t ON t.id = q.transaction_id
    WHERE t.type = 'deposit'
      AND t.status = 'pending'
      AND NULLIF(trim(COALESCE(t.proof_url, '')), '') IS NOT NULL
      AND (
        (q.status = 'pending' AND q.next_attempt_at <= now())
        OR (q.status = 'processing' AND q.locked_at < now() - interval '10 minutes')
      )
    ORDER BY q.created_at
    FOR UPDATE OF q SKIP LOCKED
    LIMIT least(greatest(COALESCE(p_limit, 20), 1), 50)
  ), claimed AS (
    UPDATE public.admin_pending_deposit_email_queue q
    SET status = 'processing',
        attempts = q.attempts + 1,
        locked_at = now(),
        last_error = NULL
    FROM candidates c
    WHERE q.id = c.id
    RETURNING q.*
  )
  SELECT
    c.id,
    t.id,
    p.account_id,
    COALESCE(
      NULLIF(concat_ws(' ', NULLIF(trim(p.first_name), ''), NULLIF(trim(p.surname), '')), ''),
      'Unknown user'
    ),
    p.email,
    p.phone,
    t.currency,
    t.amount,
    t.reference,
    COALESCE(g.label, t.growth_cycle_code, 'Growth cycle'),
    t.proof_url,
    t.created_at
  FROM claimed c
  JOIN public.transactions t ON t.id = c.transaction_id
  LEFT JOIN public.profiles p ON p.id = t.user_id
  LEFT JOIN public.growth_cycle_products g ON g.code = t.growth_cycle_code
  ORDER BY c.created_at;
$$;

CREATE OR REPLACE FUNCTION public.complete_admin_pending_deposit_email(
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
  UPDATE public.admin_pending_deposit_email_queue q
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
        ELSE left(COALESCE(p_error, 'Admin deposit alert delivery failed'), 500)
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

REVOKE ALL ON FUNCTION public.queue_admin_pending_deposit_email()
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.claim_admin_pending_deposit_emails(integer)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.complete_admin_pending_deposit_email(uuid, boolean, text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_admin_pending_deposit_emails(integer)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_admin_pending_deposit_email(uuid, boolean, text, text)
  TO service_role;

DO $$
DECLARE v_job bigint;
BEGIN
  -- Make the existing midnight job explicit now that the email-only worker
  -- handles both maturity digests and immediate deposit alerts.
  FOR v_job IN
    SELECT jobid FROM cron.job
    WHERE jobname = 'admin-maturity-alert-email-midnight-sast'
  LOOP
    PERFORM cron.unschedule(v_job);
  END LOOP;

  PERFORM cron.schedule(
    'admin-maturity-alert-email-midnight-sast',
    '0 22 * * *',
    $job$
      SELECT net.http_post(
        url := 'https://jrqrpjdlhzzfanqwinct.supabase.co/functions/v1/admin-maturity-alert-email',
        headers := '{"Content-Type":"application/json"}'::jsonb,
        body := '{"kind":"maturity"}'::jsonb,
        timeout_milliseconds := 30000
      );
    $job$
  );

  FOR v_job IN
    SELECT jobid FROM cron.job
    WHERE jobname = 'admin-pending-deposit-email-every-minute'
  LOOP
    PERFORM cron.unschedule(v_job);
  END LOOP;

  PERFORM cron.schedule(
    'admin-pending-deposit-email-every-minute',
    '* * * * *',
    $job$
      SELECT net.http_post(
        url := 'https://jrqrpjdlhzzfanqwinct.supabase.co/functions/v1/admin-maturity-alert-email',
        headers := '{"Content-Type":"application/json"}'::jsonb,
        body := '{"kind":"deposit"}'::jsonb,
        timeout_milliseconds := 30000
      );
    $job$
  );
END;
$$;
