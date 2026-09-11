-- Allow an administrator to debit only the liquid portion of a member's
-- wallet. Locked/growing principal is never reduced. Insurance repayments
-- also update the active claim so the same debt cannot be collected again.
CREATE TABLE IF NOT EXISTS public.admin_withdrawable_debit_operations (
  request_id uuid PRIMARY KEY,
  admin_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  currency text NOT NULL CHECK (currency IN ('ZAR', 'USD')),
  debit_kind text NOT NULL
    CHECK (debit_kind IN ('insurance_repayment', 'account_adjustment')),
  requested_amount numeric(18,2),
  reset_to_zero boolean NOT NULL DEFAULT false,
  reason text NOT NULL,
  deducted_amount numeric(18,2),
  withdrawable_before numeric(18,2),
  withdrawable_after numeric(18,2),
  wallet_balance_after numeric(18,2),
  insurance_claim_id uuid REFERENCES public.insurance_claims(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CHECK (
    (reset_to_zero = true AND requested_amount IS NULL)
    OR (reset_to_zero = false AND requested_amount > 0)
  )
);

CREATE INDEX IF NOT EXISTS admin_withdrawable_debit_operations_user_created_idx
  ON public.admin_withdrawable_debit_operations (user_id, created_at DESC);

ALTER TABLE public.admin_withdrawable_debit_operations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.admin_withdrawable_debit_operations
  FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.admin_withdrawable_debit_operations TO service_role;

CREATE OR REPLACE FUNCTION public.admin_debit_withdrawable_secure(
  p_user_id uuid,
  p_currency text,
  p_amount numeric,
  p_debit_kind text,
  p_reason text,
  p_reset_to_zero boolean,
  p_request_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_admin_id uuid := auth.uid();
  v_amount numeric := CASE WHEN p_amount IS NULL THEN NULL ELSE round(p_amount, 2) END;
  v_reason text := trim(COALESCE(p_reason, ''));
  v_wallet public.wallets%ROWTYPE;
  v_claim public.insurance_claims%ROWTYPE;
  v_existing public.admin_withdrawable_debit_operations%ROWTYPE;
  v_claimed_request uuid;
  v_locked numeric := 0;
  v_withdrawable numeric := 0;
  v_deduct numeric := 0;
  v_remaining numeric := 0;
  v_take numeric := 0;
  v_tranche public.deposit_tranches%ROWTYPE;
  v_description text;
  v_wallet_after numeric;
  v_withdrawable_after numeric;
BEGIN
  IF v_admin_id IS NULL
     OR NOT public.has_role(v_admin_id, 'admin'::public.app_role) THEN
    RAISE EXCEPTION 'Forbidden';
  END IF;

  IF p_request_id IS NULL
     OR p_user_id IS NULL
     OR p_currency NOT IN ('ZAR', 'USD')
     OR p_debit_kind NOT IN ('insurance_repayment', 'account_adjustment')
     OR length(v_reason) NOT BETWEEN 5 AND 500
     OR (COALESCE(p_reset_to_zero, false) = false
       AND (v_amount IS NULL OR v_amount < 0.01 OR v_amount > 10000000))
     OR (COALESCE(p_reset_to_zero, false) = true AND v_amount IS NOT NULL)
     OR (p_debit_kind = 'insurance_repayment'
       AND (p_currency <> 'ZAR' OR COALESCE(p_reset_to_zero, false) = true)) THEN
    RAISE EXCEPTION 'Invalid withdrawable deduction';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = p_user_id) THEN
    RAISE EXCEPTION 'User not found';
  END IF;

  -- Claim the request inside the same transaction as the debit. A repeated
  -- API request waits for the first one and returns its saved result.
  INSERT INTO public.admin_withdrawable_debit_operations (
    request_id, admin_id, user_id, currency, debit_kind,
    requested_amount, reset_to_zero, reason
  ) VALUES (
    p_request_id, v_admin_id, p_user_id, p_currency, p_debit_kind,
    v_amount, COALESCE(p_reset_to_zero, false), v_reason
  )
  ON CONFLICT (request_id) DO NOTHING
  RETURNING request_id INTO v_claimed_request;

  IF v_claimed_request IS NULL THEN
    SELECT * INTO v_existing
    FROM public.admin_withdrawable_debit_operations
    WHERE request_id = p_request_id
    FOR UPDATE;

    IF v_existing.admin_id IS DISTINCT FROM v_admin_id
       OR v_existing.user_id IS DISTINCT FROM p_user_id
       OR v_existing.currency IS DISTINCT FROM p_currency
       OR v_existing.debit_kind IS DISTINCT FROM p_debit_kind
       OR v_existing.requested_amount IS DISTINCT FROM v_amount
       OR v_existing.reset_to_zero IS DISTINCT FROM COALESCE(p_reset_to_zero, false)
       OR v_existing.reason IS DISTINCT FROM v_reason THEN
      RAISE EXCEPTION 'This request identifier was already used for different details';
    END IF;

    IF v_existing.completed_at IS NULL THEN
      RAISE EXCEPTION 'The original deduction has not completed';
    END IF;

    RETURN jsonb_build_object(
      'ok', true,
      'replayed', true,
      'deductedAmount', v_existing.deducted_amount,
      'withdrawableBefore', v_existing.withdrawable_before,
      'withdrawableAfter', v_existing.withdrawable_after,
      'walletBalanceAfter', v_existing.wallet_balance_after,
      'insuranceClaimId', v_existing.insurance_claim_id
    );
  END IF;

  -- Make funds due today liquid before determining what the administrator can
  -- debit. This uses the same idempotent maturity path as the member wallet.
  PERFORM public.settle_due_tranches_for_user(p_user_id);

  SELECT * INTO v_wallet
  FROM public.wallets
  WHERE user_id = p_user_id
    AND currency = p_currency
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Wallet not found';
  END IF;

  -- Lock the source rows alongside the wallet so a concurrent withdrawal or
  -- transfer cannot change the withdrawable calculation underneath us.
  PERFORM id
  FROM public.deposit_tranches
  WHERE user_id = p_user_id
    AND currency = p_currency
    AND status IN ('locked', 'matured')
    AND remaining > 0
  ORDER BY id
  FOR UPDATE;

  SELECT COALESCE(sum(remaining), 0)
  INTO v_locked
  FROM public.deposit_tranches
  WHERE user_id = p_user_id
    AND currency = p_currency
    AND status = 'locked'
    AND remaining > 0;

  v_withdrawable := greatest(0, v_wallet.balance - v_locked);
  v_deduct := CASE
    WHEN COALESCE(p_reset_to_zero, false) THEN v_withdrawable
    ELSE v_amount
  END;

  IF v_deduct IS NULL OR v_deduct <= 0 THEN
    RAISE EXCEPTION 'This wallet has no withdrawable funds to deduct';
  END IF;

  IF v_deduct > v_withdrawable THEN
    RAISE EXCEPTION 'Deduction exceeds the available withdrawable balance of % %',
      p_currency, trim(to_char(v_withdrawable, 'FM999G999G999G990D00'));
  END IF;

  IF p_debit_kind = 'insurance_repayment' THEN
    SELECT * INTO v_claim
    FROM public.insurance_claims
    WHERE user_id = p_user_id
      AND repayment_status = 'active'
    ORDER BY reviewed_at, created_at
    LIMIT 1
    FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'This user has no active insurance credit to repay';
    END IF;

    IF v_deduct > greatest(0, v_claim.repayment_total - v_claim.repayment_paid) THEN
      RAISE EXCEPTION 'Deduction exceeds the outstanding insurance balance of ZAR %',
        trim(to_char(
          greatest(0, v_claim.repayment_total - v_claim.repayment_paid),
          'FM999G999G999G990D00'
        ));
    END IF;

    UPDATE public.insurance_claims
    SET repayment_paid = repayment_paid + v_deduct,
        repayment_status = CASE
          WHEN repayment_paid + v_deduct >= repayment_total THEN 'paid'
          ELSE 'active'
        END
    WHERE id = v_claim.id;

    IF v_claim.repayment_paid + v_deduct >= v_claim.repayment_total THEN
      UPDATE public.insurance_applications
      SET credit_available = credit_limit,
          updated_at = now()
      WHERE id = v_claim.application_id;
    END IF;

    v_description := 'Admin insurance credit repayment - ' || v_claim.item
      || ' - ' || v_reason;
  ELSE
    v_description := CASE
      WHEN COALESCE(p_reset_to_zero, false)
        THEN 'Admin withdrawable balance reset - '
      ELSE 'Admin withdrawable deduction - '
    END || v_reason;
  END IF;

  -- Consume matured source balances just as a member withdrawal does. Funds
  -- without a tranche source (for example an insurance payout) are represented
  -- only by the wallet and therefore need no tranche update.
  v_remaining := v_deduct;
  FOR v_tranche IN
    SELECT *
    FROM public.deposit_tranches
    WHERE user_id = p_user_id
      AND currency = p_currency
      AND status = 'matured'
      AND remaining > 0
    ORDER BY maturity_date, created_at
    FOR UPDATE
  LOOP
    EXIT WHEN v_remaining <= 0;
    v_take := least(v_tranche.remaining, v_remaining);

    UPDATE public.deposit_tranches
    SET remaining = greatest(0, remaining - v_take),
        current_balance = greatest(0, current_balance - v_take),
        status = CASE
          WHEN remaining - v_take <= 0 THEN 'liquidated'
          ELSE status
        END
    WHERE id = v_tranche.id;

    v_remaining := v_remaining - v_take;
  END LOOP;

  UPDATE public.wallets
  SET balance = balance - v_deduct,
      updated_at = now()
  WHERE id = v_wallet.id
    AND balance - v_deduct >= v_locked
  RETURNING balance INTO v_wallet_after;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Withdrawable balance changed; retry the deduction';
  END IF;

  v_withdrawable_after := greatest(0, v_wallet_after - v_locked);

  INSERT INTO public.transactions (
    user_id, type, currency, amount, status, description, reference
  ) VALUES (
    p_user_id,
    'fee',
    p_currency,
    v_deduct,
    'completed',
    left(v_description, 700),
    'ADMIN-DEBIT-' || p_request_id::text
  );

  UPDATE public.admin_withdrawable_debit_operations
  SET deducted_amount = v_deduct,
      withdrawable_before = v_withdrawable,
      withdrawable_after = v_withdrawable_after,
      wallet_balance_after = v_wallet_after,
      insurance_claim_id = CASE
        WHEN p_debit_kind = 'insurance_repayment' THEN v_claim.id
        ELSE NULL
      END,
      completed_at = now()
  WHERE request_id = p_request_id;

  RETURN jsonb_build_object(
    'ok', true,
    'replayed', false,
    'deductedAmount', v_deduct,
    'withdrawableBefore', v_withdrawable,
    'withdrawableAfter', v_withdrawable_after,
    'walletBalanceAfter', v_wallet_after,
    'insuranceClaimId', CASE
      WHEN p_debit_kind = 'insurance_repayment' THEN v_claim.id
      ELSE NULL
    END
  );
END;
$$;

REVOKE ALL ON FUNCTION public.admin_debit_withdrawable_secure(
  uuid, text, numeric, text, text, boolean, uuid
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_debit_withdrawable_secure(
  uuid, text, numeric, text, text, boolean, uuid
) TO authenticated;
