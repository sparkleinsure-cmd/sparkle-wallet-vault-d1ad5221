CREATE TABLE public.deposit_tranches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  currency text NOT NULL,
  amount numeric NOT NULL,
  remaining numeric NOT NULL,
  source text NOT NULL DEFAULT 'deposit',
  parent_tranche_id uuid REFERENCES public.deposit_tranches(id) ON DELETE SET NULL,
  transaction_id uuid,
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  maturity_date timestamptz NOT NULL
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.deposit_tranches TO authenticated;
GRANT ALL ON public.deposit_tranches TO service_role;
ALTER TABLE public.deposit_tranches ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own tranches read" ON public.deposit_tranches FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "own tranches insert" ON public.deposit_tranches FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY "own tranches update" ON public.deposit_tranches FOR UPDATE TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "admin tranches all" ON public.deposit_tranches FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin'::app_role)) WITH CHECK (public.has_role(auth.uid(), 'admin'::app_role));
CREATE INDEX deposit_tranches_user_created_idx ON public.deposit_tranches (user_id, currency, created_at);