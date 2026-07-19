-- Admin server functions use the requesting admin's authenticated session.
-- Allow that role to look up account holders and display the owner details for
-- pending deposits and withdrawals without requiring the service-role secret.
CREATE POLICY "admin profiles all" ON public.profiles
  FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin'::public.app_role))
  WITH CHECK (public.has_role(auth.uid(), 'admin'::public.app_role));
