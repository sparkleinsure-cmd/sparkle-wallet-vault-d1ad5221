
ALTER FUNCTION public.generate_account_id() SET search_path = public;
REVOKE EXECUTE ON FUNCTION public.has_role(UUID, public.app_role) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.handle_new_user() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.grant_admin_on_verify() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.generate_account_id() FROM PUBLIC, anon;
