
-- Fix OTP insert RLS
CREATE POLICY "own otp insert" ON public.otp_codes
  FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);

-- Add 'adjustment' tx type for admin corrections
ALTER TYPE tx_type ADD VALUE IF NOT EXISTS 'adjustment';

-- Add proof_url column to transactions for deposit receipts
ALTER TABLE public.transactions ADD COLUMN IF NOT EXISTS proof_url TEXT;

-- Allow users to insert their own deposit transactions (pending until admin verifies),
-- and admins to update transactions (verify / adjust)
CREATE POLICY "own tx insert" ON public.transactions
  FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "admin tx all" ON public.transactions
  FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

-- Allow users to update their own wallet balance on deposit
CREATE POLICY "own wallets update" ON public.wallets
  FOR UPDATE TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "admin wallets all" ON public.wallets
  FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

-- Storage policies for deposits bucket
CREATE POLICY "users upload own deposit proofs" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'deposits' AND (storage.foldername(name))[1] = auth.uid()::text);

CREATE POLICY "users read own deposit proofs" ON storage.objects
  FOR SELECT TO authenticated
  USING (bucket_id = 'deposits' AND ((storage.foldername(name))[1] = auth.uid()::text OR public.has_role(auth.uid(), 'admin')));
