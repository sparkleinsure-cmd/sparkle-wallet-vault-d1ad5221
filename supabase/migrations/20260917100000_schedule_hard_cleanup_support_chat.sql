-- Support chat is intentionally ephemeral.  The first cleanup migration
-- defined the function but did not register a cron job, which meant cleanup
-- only occurred when a member happened to reopen their thread.
CREATE EXTENSION IF NOT EXISTS pg_cron;

CREATE OR REPLACE FUNCTION public.cleanup_stale_support_messages()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- A conversation is the thread itself. Deleting it also deletes its
  -- messages through the foreign-key cascade, preventing old empty threads
  -- from remaining in the administrator inbox.
  DELETE FROM public.support_conversations
  WHERE last_message_at < now() - interval '24 hours';

  -- This protects against old orphaned messages if legacy data was imported
  -- without a valid conversation.
  DELETE FROM public.support_messages
  WHERE created_at < now() - interval '24 hours';
END;
$$;

REVOKE ALL ON FUNCTION public.cleanup_stale_support_messages() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cleanup_stale_support_messages() TO service_role;

-- Remove stale records immediately when this migration is applied, then keep
-- enforcing the 24-hour retention limit even if no member opens Support.
SELECT public.cleanup_stale_support_messages();

DO $$
DECLARE v_job bigint;
BEGIN
  FOR v_job IN
    SELECT jobid FROM cron.job
    WHERE jobname = 'support-chat-cleanup-every-five-minutes'
  LOOP
    PERFORM cron.unschedule(v_job);
  END LOOP;

  PERFORM cron.schedule(
    'support-chat-cleanup-every-five-minutes',
    '*/5 * * * *',
    $job$SELECT public.cleanup_stale_support_messages();$job$
  );
END;
$$;
