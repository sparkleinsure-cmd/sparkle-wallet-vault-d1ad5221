-- Automatically clear support messages older than 24 hours and revert conversation status
CREATE OR REPLACE FUNCTION public.cleanup_stale_support_messages()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Delete messages older than 24 hours
  DELETE FROM public.support_messages
  WHERE created_at < now() - interval '24 hours';

  -- Revert conversations that have no messages left or haven't been active in 24 hours back to initial 'ai' state
  UPDATE public.support_conversations
  SET status = 'ai',
      assigned_admin_id = NULL,
      human_requested_at = NULL,
      unread_by_admin = 0,
      unread_by_user = 0,
      updated_at = now()
  WHERE last_message_at < now() - interval '24 hours'
     OR NOT EXISTS (
       SELECT 1 FROM public.support_messages m
       WHERE m.conversation_id = support_conversations.id
     );
END;
$$;

REVOKE ALL ON FUNCTION public.cleanup_stale_support_messages() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cleanup_stale_support_messages() TO service_role;
