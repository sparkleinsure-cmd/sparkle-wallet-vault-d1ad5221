-- The wallet health trigger is shared by wallets and transactions. The
-- previous version referenced NEW.status even when fired by public.wallets,
-- which has no status column, causing deposits, withdrawals, and admin
-- approvals to roll back with: record "new" has no field "status".

CREATE OR REPLACE FUNCTION public.refresh_wallet_health_from_activity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id uuid;
  v_currency text;
  v_status public.tx_status;
BEGIN
  IF TG_TABLE_NAME = 'wallets' THEN
    IF TG_OP = 'DELETE' THEN
      v_user_id := OLD.user_id;
      v_currency := OLD.currency;
    ELSE
      v_user_id := NEW.user_id;
      v_currency := NEW.currency;
    END IF;

    IF v_currency = 'ZAR' THEN
      PERFORM public.record_wallet_health_snapshot(v_user_id);
    END IF;

    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;

  IF TG_TABLE_NAME = 'transactions' THEN
    IF TG_OP = 'DELETE' THEN
      v_user_id := OLD.user_id;
      v_currency := OLD.currency;
      v_status := OLD.status;
    ELSE
      v_user_id := NEW.user_id;
      v_currency := NEW.currency;
      v_status := NEW.status;
    END IF;

    IF v_currency = 'ZAR' AND (TG_OP <> 'INSERT' OR v_status = 'completed') THEN
      PERFORM public.record_wallet_health_snapshot(v_user_id);
    END IF;

    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'refresh_wallet_health_from_activity cannot run for table %', TG_TABLE_NAME;
END;
$$;
