-- Use one clear customer-facing label for deposits verified by an administrator.
-- Update existing ledger records, including the label used by an earlier flow.
UPDATE public.transactions
SET description = CASE
  WHEN description LIKE 'Deposit approved by administrator%' THEN
    'Deposit verified by admin' || substr(description, length('Deposit approved by administrator') + 1)
  WHEN description LIKE 'Verified by admin%' THEN
    'Deposit verified by admin' || substr(description, length('Verified by admin') + 1)
  ELSE description
END
WHERE type = 'deposit'
  AND (
    description LIKE 'Deposit approved by administrator%'
    OR description LIKE 'Verified by admin%'
  );

CREATE OR REPLACE FUNCTION public.admin_approve_deposit_secure(
  p_tx_id uuid,
  p_corrected_amount numeric DEFAULT NULL,
  p_note text DEFAULT NULL
)
RETURNS numeric LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_tx public.transactions%ROWTYPE;
  v_amount numeric;
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(), 'admin'::public.app_role) THEN
    RAISE EXCEPTION 'Forbidden';
  END IF;

  SELECT * INTO v_tx FROM public.transactions WHERE id = p_tx_id FOR UPDATE;
  IF NOT FOUND OR v_tx.type <> 'deposit' OR v_tx.status <> 'pending' THEN
    RAISE EXCEPTION 'Deposit not found or already processed';
  END IF;

  v_amount := COALESCE(p_corrected_amount, v_tx.amount);
  IF v_amount <= 0 OR v_amount > 10000000 THEN
    RAISE EXCEPTION 'Invalid amount';
  END IF;

  UPDATE public.transactions
  SET amount = round(v_amount, 2),
      status = 'completed',
      description = 'Deposit verified by admin' || CASE
        WHEN length(trim(COALESCE(p_note, ''))) > 0 THEN ' — ' || left(trim(p_note), 300)
        ELSE ''
      END
  WHERE id = v_tx.id;

  UPDATE public.wallets
  SET balance = balance + round(v_amount, 2), updated_at = now()
  WHERE user_id = v_tx.user_id AND currency = v_tx.currency;

  INSERT INTO public.deposit_tranches (
    user_id, currency, amount, remaining, current_balance, status, source,
    transaction_id, maturity_date, approved
  ) VALUES (
    v_tx.user_id, v_tx.currency, round(v_amount, 2), round(v_amount, 2),
    round(v_amount, 2), 'locked', 'deposit', v_tx.id, now() + interval '30 days', true
  );

  RETURN round(v_amount, 2);
END;
$$;
