-- Administrators use their own accounts for testing. This reset removes only
-- their locked growing cycles. Locked principal is subtracted from the wallet
-- at the same time, so it can never become withdrawable as a side effect.
CREATE TABLE IF NOT EXISTS public.admin_growing_clear_operations (
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  request_id uuid NOT NULL,
  result jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, request_id)
);

ALTER TABLE public.admin_growing_clear_operations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.admin_growing_clear_operations FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.admin_clear_own_growing_balance_secure(
  p_request_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id uuid := auth.uid();
  v_reference_prefix text := 'ADMIN-GROWING-CLEAR-' || p_request_id::text;
  v_currency record;
  v_cleared_by_currency jsonb := '{}'::jsonb;
  v_cleared_cycles integer := 0;
  v_total_cycles integer := 0;
  v_claimed_request uuid;
  v_existing_result jsonb;
  v_result jsonb;
BEGIN
  IF v_user_id IS NULL OR p_request_id IS NULL
     OR NOT public.has_role(v_user_id, 'admin'::public.app_role) THEN
    RAISE EXCEPTION 'Forbidden';
  END IF;

  -- Claim the request before touching balances. The row is committed together
  -- with the reset, so concurrent retries wait and receive the saved result.
  INSERT INTO public.admin_growing_clear_operations (user_id, request_id)
  VALUES (v_user_id, p_request_id)
  ON CONFLICT (user_id, request_id) DO NOTHING
  RETURNING request_id INTO v_claimed_request;

  IF v_claimed_request IS NULL THEN
    SELECT result INTO v_existing_result
    FROM public.admin_growing_clear_operations
    WHERE user_id = v_user_id AND request_id = p_request_id
    FOR UPDATE;

    RETURN COALESCE(v_existing_result, jsonb_build_object(
      'ok', true, 'replayed', true,
      'clearedCycles', 0, 'clearedByCurrency', '{}'::jsonb
    )) || jsonb_build_object('replayed', true);
  END IF;

  -- Funds already due are settled first and remain withdrawable; only cycles
  -- that are still locked after settlement participate in the test reset.
  PERFORM public.settle_due_tranches_for_user(v_user_id);

  IF EXISTS (
    SELECT 1 FROM public.deposit_tranches
    WHERE user_id = v_user_id
      AND status = 'locked'
      AND approved = true
      AND maturity_date <= now()
      AND remaining > 0
  ) THEN
    RAISE EXCEPTION 'A matured cycle could not be settled safely; no growing funds were cleared';
  END IF;

  PERFORM id
  FROM public.deposit_tranches
  WHERE user_id = v_user_id
    AND status = 'locked'
    AND approved = true
    AND maturity_date > now()
    AND remaining > 0
  ORDER BY id
  FOR UPDATE;

  FOR v_currency IN
    SELECT currency, round(sum(remaining), 2) AS locked_principal, count(*)::integer AS cycle_count
    FROM public.deposit_tranches
    WHERE user_id = v_user_id
      AND status = 'locked'
      AND approved = true
      AND maturity_date > now()
      AND remaining > 0
    GROUP BY currency
    ORDER BY currency
  LOOP
    UPDATE public.wallets
    SET balance = balance - v_currency.locked_principal,
        updated_at = now()
    WHERE user_id = v_user_id
      AND currency = v_currency.currency
      AND balance >= v_currency.locked_principal;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Cannot safely clear % growing balance because its wallet is inconsistent', v_currency.currency;
    END IF;

    UPDATE public.deposit_tranches
    SET remaining = 0,
        current_balance = 0,
        target_gain = CASE WHEN target_gain IS NULL THEN NULL ELSE 0 END,
        status = 'liquidated',
        note = concat_ws(' | ', NULLIF(note, ''), 'Cleared by administrator test-balance reset')
    WHERE user_id = v_user_id
      AND currency = v_currency.currency
      AND status = 'locked'
      AND approved = true
      AND maturity_date > now()
      AND remaining > 0;

    GET DIAGNOSTICS v_total_cycles = ROW_COUNT;
    IF v_total_cycles <> v_currency.cycle_count THEN
      RAISE EXCEPTION 'Growing cycles changed during reset; no funds were cleared';
    END IF;

    INSERT INTO public.transactions (
      user_id, type, currency, amount, status, description, reference
    ) VALUES (
      v_user_id,
      'adjustment',
      v_currency.currency,
      v_currency.locked_principal,
      'completed',
      'Admin test reset - cleared growing principal from ' || v_currency.cycle_count || ' active cycle(s)',
      v_reference_prefix || '-' || v_currency.currency
    );

    v_cleared_by_currency := jsonb_set(
      v_cleared_by_currency,
      ARRAY[v_currency.currency],
      to_jsonb(v_currency.locked_principal),
      true
    );
    v_cleared_cycles := v_cleared_cycles + v_currency.cycle_count;
  END LOOP;

  v_result := jsonb_build_object(
    'ok', true,
    'replayed', false,
    'clearedCycles', v_cleared_cycles,
    'clearedByCurrency', v_cleared_by_currency
  );

  UPDATE public.admin_growing_clear_operations
  SET result = v_result
  WHERE user_id = v_user_id AND request_id = p_request_id;

  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_clear_own_growing_balance_secure(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_clear_own_growing_balance_secure(uuid)
  TO authenticated;
