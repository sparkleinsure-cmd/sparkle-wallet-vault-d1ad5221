-- Count registered member profiles and their activity in one database snapshot.
-- Auth accounts without a member profile are reported separately for diagnosis.
CREATE OR REPLACE FUNCTION public.admin_user_counts()
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT jsonb_build_object(
    'count', (SELECT count(*) FROM public.profiles),
    'onlineCount', (
      SELECT count(*) FROM public.profiles p
      JOIN public.user_presence s ON s.user_id = p.id
      WHERE s.last_seen_at >= now() - interval '2 minutes'
    ),
    'authUserCount', (SELECT count(*) FROM auth.users WHERE deleted_at IS NULL)
  );
$$;
REVOKE ALL ON FUNCTION public.admin_user_counts() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_user_counts() TO service_role;
