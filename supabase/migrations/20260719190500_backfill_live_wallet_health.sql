-- Seed today's live view for existing account holders. Later transaction and
-- wallet changes are captured automatically by the deferred triggers.
DO $$
DECLARE
  p record;
BEGIN
  FOR p IN SELECT id FROM public.profiles LOOP
    PERFORM public.record_wallet_health_snapshot(p.id);
  END LOOP;
END;
$$;
