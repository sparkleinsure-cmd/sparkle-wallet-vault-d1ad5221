-- Several independent Edge Functions previously started on the same minute
-- boundary. On the small production instance this could surface intermittent
-- 504s. Keep admin queue work sequential and run cleanup at the cadence its
-- five-minute retention grace period requires.
CREATE INDEX IF NOT EXISTS withdrawable_credit_email_retry_lock_idx
  ON public.withdrawable_credit_email_queue(locked_at,created_at)
  WHERE status='processing';
CREATE INDEX IF NOT EXISTS withdrawable_credit_sms_retry_lock_idx
  ON public.withdrawable_credit_email_queue(sms_locked_at,created_at)
  WHERE sms_status='processing';
CREATE INDEX IF NOT EXISTS admin_pending_deposit_email_retry_lock_idx
  ON public.admin_pending_deposit_email_queue(locked_at,created_at)
  WHERE status='processing';
CREATE INDEX IF NOT EXISTS admin_auto_approval_email_retry_lock_idx
  ON public.admin_auto_approval_email_queue(locked_at,created_at)
  WHERE status='processing';
CREATE INDEX IF NOT EXISTS admin_auto_approval_email_batch_idx
  ON public.admin_auto_approval_email_queue(batch_id,created_at)
  WHERE status IN ('pending','processing');

CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;

DO $$
DECLARE v_job bigint;
BEGIN
  FOR v_job IN SELECT jobid FROM cron.job WHERE jobname IN (
    'admin-pending-deposit-email-every-minute',
    'admin-auto-approval-email-every-minute',
    'admin-routine-email-every-minute'
  )
  LOOP PERFORM cron.unschedule(v_job); END LOOP;

  PERFORM cron.schedule(
    'admin-routine-email-every-minute','* * * * *',
    $job$
      SELECT net.http_post(
        url := 'https://jrqrpjdlhzzfanqwinct.supabase.co/functions/v1/admin-maturity-alert-email',
        headers := '{"Content-Type":"application/json"}'::jsonb,
        body := '{"kind":"routine"}'::jsonb,
        timeout_milliseconds := 30000
      );
    $job$
  );

  FOR v_job IN SELECT jobid FROM cron.job WHERE jobname IN (
    'review-storage-cleanup-every-minute',
    'review-storage-cleanup-every-five-minutes'
  )
  LOOP PERFORM cron.unschedule(v_job); END LOOP;

  PERFORM cron.schedule(
    'review-storage-cleanup-every-five-minutes','*/5 * * * *',
    $job$
      SELECT net.http_post(
        url := 'https://jrqrpjdlhzzfanqwinct.supabase.co/functions/v1/storage-cleanup',
        headers := '{"Content-Type":"application/json"}'::jsonb,
        body := '{}'::jsonb,
        timeout_milliseconds := 10000
      );
    $job$
  );
END;
$$;
