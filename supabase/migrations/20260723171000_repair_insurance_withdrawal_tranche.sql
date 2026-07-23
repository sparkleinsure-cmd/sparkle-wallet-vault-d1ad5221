-- Repair the first insurance payout withdrawal affected by the old allocation
-- rule. The wallet debit was correct, but the same amount was also removed
-- from locked tranches, which made the displayed withdrawable value persist.
DO $$
DECLARE
  v_user uuid;
  v_amount numeric := 650;
  v_left numeric := 650;
  v_tranche public.deposit_tranches%ROWTYPE;
  v_restore numeric;
BEGIN
  SELECT p.id INTO v_user
  FROM public.profiles p
  WHERE p.account_id='64A3FHNE'
    AND EXISTS (
      SELECT 1 FROM public.transactions i
      WHERE i.user_id=p.id AND i.type='bonus' AND i.amount=650
        AND i.description ILIKE 'Insurance claim payout%'
        AND i.created_at::date=DATE '2026-07-23'
    )
    AND EXISTS (
      SELECT 1 FROM public.transactions w
      WHERE w.user_id=p.id AND w.type='withdrawal' AND w.amount=650
        AND w.created_at::date=DATE '2026-07-23'
    );
  IF v_user IS NULL THEN RETURN; END IF;

  FOR v_tranche IN
    SELECT * FROM public.deposit_tranches
    WHERE user_id=v_user AND currency='ZAR'
      AND amount>remaining AND maturity_date>now()
    ORDER BY maturity_date,created_at
    FOR UPDATE
  LOOP
    EXIT WHEN v_left<=0;
    v_restore:=least(v_left,v_tranche.amount-v_tranche.remaining);
    UPDATE public.deposit_tranches
    SET remaining=remaining+v_restore,
        current_balance=current_balance+v_restore,
        status='locked'
    WHERE id=v_tranche.id;
    v_left:=v_left-v_restore;
  END LOOP;
END $$;
