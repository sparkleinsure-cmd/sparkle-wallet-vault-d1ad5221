-- Guarded one-off repair for the referral reported on 2026-07-31.
-- Every supplied identity is verified before any financial mutation, and an
-- existing paid referral makes this migration a no-op.
DO $$
DECLARE
  v_referrer public.profiles%ROWTYPE;
  v_referred public.profiles%ROWTYPE;
  v_referral public.referrals%ROWTYPE;
  v_deposit public.transactions%ROWTYPE;
  v_reward numeric;
  v_reward_tx_id uuid;
BEGIN
  SELECT * INTO v_referrer FROM public.profiles WHERE account_id = 'UE38UQ3M';
  IF NOT FOUND THEN RAISE EXCEPTION 'Repair aborted: referrer UE38UQ3M was not found'; END IF;

  SELECT * INTO v_referred FROM public.profiles
  WHERE account_id = 'ANP3P5VX' AND lower(email) = 'vertmusicsa@gmail.com';
  IF NOT FOUND THEN RAISE EXCEPTION 'Repair aborted: invited member identity did not match'; END IF;
  IF v_referrer.id = v_referred.id THEN RAISE EXCEPTION 'Repair aborted: self-referral'; END IF;

  SELECT * INTO v_referral FROM public.referrals
  WHERE referred_user_id = v_referred.id FOR UPDATE;

  IF FOUND AND v_referral.referrer_id <> v_referrer.id THEN
    RAISE EXCEPTION 'Repair aborted: invited member is attributed to another referrer';
  END IF;

  IF NOT FOUND THEN
    INSERT INTO public.referrals (referrer_id, referred_user_id, referral_code, created_at)
    VALUES (v_referrer.id, v_referred.id, v_referrer.account_id, v_referred.created_at)
    RETURNING * INTO v_referral;
  END IF;

  IF v_referral.rewarded_at IS NULL THEN
    SELECT * INTO v_deposit FROM public.transactions
    WHERE user_id = v_referred.id AND type = 'deposit' AND status = 'completed'
    ORDER BY created_at, id LIMIT 1;
    IF NOT FOUND THEN RAISE EXCEPTION 'Repair aborted: invited member has no completed deposit'; END IF;

    v_reward := round(v_deposit.amount * 0.10, 2);
    IF v_reward <= 0 THEN RAISE EXCEPTION 'Repair aborted: calculated reward is not positive'; END IF;

    UPDATE public.wallets
    SET balance = balance + v_reward, updated_at = now()
    WHERE user_id = v_referrer.id AND currency = v_deposit.currency;
    IF NOT FOUND THEN RAISE EXCEPTION 'Repair aborted: referrer wallet was not found'; END IF;

    INSERT INTO public.transactions (user_id, type, currency, amount, status, description, reference)
    VALUES (v_referrer.id, 'bonus', v_deposit.currency, v_reward, 'completed',
            '10% referral bonus', 'REF-' || left(v_referral.id::text, 8))
    RETURNING id INTO v_reward_tx_id;

    INSERT INTO public.deposit_tranches (
      user_id, currency, amount, remaining, current_balance, status, source,
      transaction_id, maturity_date, approved, note
    ) VALUES (
      v_referrer.id, v_deposit.currency, v_reward, v_reward, v_reward,
      'matured', 'referral', v_reward_tx_id, now(), true,
      'Immediately withdrawable referral reward'
    );

    UPDATE public.referrals SET
      first_deposit_transaction_id = v_deposit.id,
      first_deposit_amount = round(v_deposit.amount, 2),
      reward_amount = v_reward,
      reward_currency = v_deposit.currency,
      rewarded_at = now()
    WHERE id = v_referral.id;
  END IF;
END;
$$;
