-- Correct liquid withdrawals and add repayable appliance-insurance facilities.
ALTER TABLE public.insurance_claims
  ADD COLUMN IF NOT EXISTS repayment_principal numeric(18,2),
  ADD COLUMN IF NOT EXISTS repayment_interest numeric(18,2),
  ADD COLUMN IF NOT EXISTS repayment_total numeric(18,2),
  ADD COLUMN IF NOT EXISTS repayment_paid numeric(18,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS instalment_amount numeric(18,2),
  ADD COLUMN IF NOT EXISTS repayment_status text NOT NULL DEFAULT 'none'
    CHECK (repayment_status IN ('none','active','paid'));

CREATE OR REPLACE FUNCTION public.collect_insurance_repayment(p_user_id uuid)
RETURNS numeric LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE
  v_claim public.insurance_claims%ROWTYPE;
  v_app public.insurance_applications%ROWTYPE;
  v_wallet public.wallets%ROWTYPE;
  v_locked numeric := 0;
  v_available numeric := 0;
  v_due numeric := 0;
  v_collect numeric := 0;
BEGIN
  SELECT * INTO v_claim
  FROM public.insurance_claims
  WHERE user_id=p_user_id AND repayment_status='active'
  ORDER BY reviewed_at
  LIMIT 1 FOR UPDATE;
  IF NOT FOUND THEN RETURN 0; END IF;

  SELECT * INTO v_wallet FROM public.wallets
  WHERE user_id=p_user_id AND currency='ZAR' FOR UPDATE;
  IF NOT FOUND THEN RETURN 0; END IF;

  SELECT COALESCE(sum(remaining),0) INTO v_locked
  FROM public.deposit_tranches
  WHERE user_id=p_user_id AND currency='ZAR' AND status='locked'
    AND maturity_date>now() AND remaining>0;
  v_available := greatest(0, v_wallet.balance-v_locked);
  v_due := greatest(0, v_claim.repayment_total-v_claim.repayment_paid);
  v_collect := least(v_available, v_due, v_claim.instalment_amount);
  IF v_collect <= 0 THEN RETURN 0; END IF;

  UPDATE public.wallets SET balance=balance-v_collect,updated_at=now()
  WHERE id=v_wallet.id;
  UPDATE public.insurance_claims
  SET repayment_paid=repayment_paid+v_collect,
      repayment_status=CASE WHEN repayment_paid+v_collect>=repayment_total THEN 'paid' ELSE 'active' END
  WHERE id=v_claim.id;
  INSERT INTO public.transactions(user_id,type,currency,amount,status,description,reference)
  VALUES(p_user_id,'fee','ZAR',v_collect,'completed',
    'Insurance credit repayment - '||v_claim.item,v_claim.id::text);

  IF v_claim.repayment_paid+v_collect>=v_claim.repayment_total THEN
    SELECT * INTO v_app FROM public.insurance_applications WHERE id=v_claim.application_id FOR UPDATE;
    UPDATE public.insurance_applications
    SET credit_available=credit_limit,updated_at=now()
    WHERE id=v_claim.application_id;
  END IF;
  RETURN v_collect;
END; $$;

CREATE OR REPLACE FUNCTION public.insurance_eligibility(p_user_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_created timestamptz; v_deposits numeric;
BEGIN
  IF auth.uid() IS NULL OR (auth.uid()<>p_user_id AND NOT public.has_role(auth.uid(),'admin')) THEN
    RAISE EXCEPTION 'Forbidden';
  END IF;
  SELECT created_at INTO v_created FROM auth.users WHERE id=p_user_id;
  SELECT COALESCE(sum(amount),0) INTO v_deposits
  FROM public.transactions
  WHERE user_id=p_user_id AND currency='ZAR' AND type='deposit'
    AND status='completed' AND created_at>=now()-interval '30 days';
  RETURN jsonb_build_object(
    'accountAgeDays', greatest(0,floor(extract(epoch FROM (now()-v_created))/86400)),
    'depositsLast30Days', v_deposits,
    'eligible', v_created<=now()-interval '30 days' AND v_deposits>=1000
  );
END; $$;

CREATE OR REPLACE FUNCTION public.collect_insurance_when_funds_mature()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
  IF NEW.currency='ZAR' AND NEW.status='matured'
     AND (TG_OP='INSERT' OR OLD.status IS DISTINCT FROM 'matured') THEN
    PERFORM public.collect_insurance_repayment(NEW.user_id);
  END IF;
  RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS collect_insurance_on_matured_funds ON public.deposit_tranches;
CREATE TRIGGER collect_insurance_on_matured_funds
AFTER INSERT OR UPDATE OF status ON public.deposit_tranches
FOR EACH ROW EXECUTE FUNCTION public.collect_insurance_when_funds_mature();

CREATE OR REPLACE FUNCTION public.submit_insurance_application(
  p_items text[], p_bank_paths text[], p_payslip_path text, p_id_copy_path text
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_id uuid; v_path text; v_eligibility jsonb;
BEGIN
  IF auth.uid() IS NULL OR cardinality(p_items) NOT BETWEEN 1 AND 20 OR cardinality(p_bank_paths) NOT BETWEEN 1 AND 3 THEN RAISE EXCEPTION 'Invalid insurance application'; END IF;
  v_eligibility:=public.insurance_eligibility(auth.uid());
  IF NOT (v_eligibility->>'eligible')::boolean THEN
    RAISE EXCEPTION 'Insurance requires an account older than 30 days and at least R1,000 in completed deposits during the last 30 days';
  END IF;
  IF EXISTS (SELECT 1 FROM insurance_applications WHERE user_id=auth.uid() AND status IN ('pending','approved')) THEN RAISE EXCEPTION 'You already have an active insurance application'; END IF;
  FOREACH v_path IN ARRAY p_bank_paths LOOP IF split_part(v_path,'/',1)<>auth.uid()::text THEN RAISE EXCEPTION 'Invalid document path'; END IF; END LOOP;
  IF split_part(p_payslip_path,'/',1)<>auth.uid()::text OR split_part(p_id_copy_path,'/',1)<>auth.uid()::text THEN RAISE EXCEPTION 'Invalid document path'; END IF;
  INSERT INTO insurance_applications(user_id,selected_items,bank_statement_paths,payslip_path,id_copy_path)
  VALUES(auth.uid(),p_items,p_bank_paths,p_payslip_path,p_id_copy_path) RETURNING id INTO v_id;
  RETURN v_id;
END; $$;

CREATE OR REPLACE FUNCTION public.submit_insurance_claim(p_item text,p_amount numeric,p_quotation_path text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_app insurance_applications%ROWTYPE; v_id uuid;
BEGIN
  SELECT * INTO v_app FROM insurance_applications WHERE user_id=auth.uid() AND status='approved' ORDER BY created_at DESC LIMIT 1;
  IF NOT FOUND THEN RAISE EXCEPTION 'No approved insurance facility found'; END IF;
  IF EXISTS(SELECT 1 FROM insurance_claims WHERE user_id=auth.uid() AND repayment_status='active') THEN RAISE EXCEPTION 'Your previous insurance credit must be repaid before another claim'; END IF;
  IF NOT (p_item=ANY(v_app.selected_items)) OR p_amount<=0 OR p_amount>v_app.credit_available THEN RAISE EXCEPTION 'Invalid claim amount or item'; END IF;
  IF split_part(p_quotation_path,'/',1)<>auth.uid()::text THEN RAISE EXCEPTION 'Invalid quotation path'; END IF;
  IF EXISTS(SELECT 1 FROM insurance_claims WHERE user_id=auth.uid() AND status='pending') THEN RAISE EXCEPTION 'Your previous claim is still being reviewed'; END IF;
  INSERT INTO insurance_claims(application_id,user_id,item,requested_amount,quotation_path)
  VALUES(v_app.id,auth.uid(),p_item,p_amount,p_quotation_path) RETURNING id INTO v_id;
  RETURN v_id;
END; $$;

CREATE OR REPLACE FUNCTION public.admin_review_insurance_application(p_application_id uuid,p_status text,p_credit numeric,p_note text DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_user uuid; v_eligibility jsonb;
BEGIN
  IF NOT public.has_role(auth.uid(),'admin') THEN RAISE EXCEPTION 'Forbidden'; END IF;
  IF p_status NOT IN ('approved','declined') OR (p_status='approved' AND (p_credit<=0 OR p_credit>1000000)) THEN RAISE EXCEPTION 'Invalid review'; END IF;
  SELECT user_id INTO v_user FROM insurance_applications WHERE id=p_application_id AND status='pending';
  IF NOT FOUND THEN RAISE EXCEPTION 'Application already processed or not found'; END IF;
  IF p_status='approved' THEN
    v_eligibility:=public.insurance_eligibility(v_user);
    IF NOT (v_eligibility->>'eligible')::boolean THEN RAISE EXCEPTION 'User does not meet the 30-day account and R1,000 deposit eligibility requirements'; END IF;
  END IF;
  UPDATE insurance_applications SET status=p_status,credit_limit=CASE WHEN p_status='approved' THEN p_credit ELSE 0 END,
    credit_available=CASE WHEN p_status='approved' THEN p_credit ELSE 0 END,admin_note=NULLIF(trim(p_note),''),reviewed_by=auth.uid(),reviewed_at=now(),updated_at=now()
  WHERE id=p_application_id AND status='pending';
END; $$;

CREATE OR REPLACE FUNCTION public.admin_review_insurance_claim(p_claim_id uuid,p_status text,p_approved_amount numeric,p_note text DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_claim insurance_claims%ROWTYPE; v_app insurance_applications%ROWTYPE; v_total numeric; v_instalment numeric;
BEGIN
  IF NOT public.has_role(auth.uid(),'admin') THEN RAISE EXCEPTION 'Forbidden'; END IF;
  IF p_status NOT IN ('approved','declined') THEN RAISE EXCEPTION 'Invalid review'; END IF;
  SELECT * INTO v_claim FROM insurance_claims WHERE id=p_claim_id AND status='pending' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Claim already processed or not found'; END IF;
  SELECT * INTO v_app FROM insurance_applications WHERE id=v_claim.application_id FOR UPDATE;
  IF p_status='approved' AND (p_approved_amount<=0 OR p_approved_amount>v_claim.requested_amount OR p_approved_amount>v_app.credit_available) THEN RAISE EXCEPTION 'Approved amount exceeds the claim or available facility'; END IF;
  v_total:=round(p_approved_amount*1.40,2);
  v_instalment:=round(v_total/3,2);
  UPDATE insurance_claims SET status=p_status,approved_amount=CASE WHEN p_status='approved' THEN p_approved_amount ELSE NULL END,
    repayment_principal=CASE WHEN p_status='approved' THEN p_approved_amount ELSE NULL END,
    repayment_interest=CASE WHEN p_status='approved' THEN round(p_approved_amount*.40,2) ELSE NULL END,
    repayment_total=CASE WHEN p_status='approved' THEN v_total ELSE NULL END,
    instalment_amount=CASE WHEN p_status='approved' THEN v_instalment ELSE NULL END,
    repayment_status=CASE WHEN p_status='approved' THEN 'active' ELSE 'none' END,
    admin_note=NULLIF(trim(p_note),''),reviewed_by=auth.uid(),reviewed_at=now() WHERE id=p_claim_id;
  IF p_status='approved' THEN
    UPDATE insurance_applications SET credit_available=credit_available-p_approved_amount,updated_at=now() WHERE id=v_app.id;
    UPDATE wallets SET balance=balance+p_approved_amount,updated_at=now() WHERE user_id=v_claim.user_id AND currency='ZAR';
    INSERT INTO transactions(user_id,type,currency,amount,status,description,reference)
    VALUES(v_claim.user_id,'bonus','ZAR',p_approved_amount,'completed','Insurance claim payout - '||v_claim.item,v_claim.id::text);
  END IF;
END; $$;

CREATE OR REPLACE FUNCTION public.request_withdrawal_secure(
  p_amount numeric, p_currency text, p_bank_name text DEFAULT NULL,
  p_account_number text DEFAULT NULL, p_confirm_break boolean DEFAULT false
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE
  v_wallet public.wallets%ROWTYPE; v_profile public.profiles%ROWTYPE;
  v_tranche public.deposit_tranches%ROWTYPE; v_locked numeric := 0;
  v_withdrawable numeric; v_growing_take numeric; v_remaining numeric; v_take numeric;
  v_penalty numeric; v_payout numeric; v_tx uuid; v_repaid numeric := 0;
BEGIN
  IF auth.uid() IS NULL OR p_currency NOT IN ('ZAR','USD') OR p_amount<=0 OR p_amount>10000000 THEN RAISE EXCEPTION 'Invalid withdrawal request'; END IF;
  IF p_currency='ZAR' THEN v_repaid:=public.collect_insurance_repayment(auth.uid()); END IF;
  SELECT * INTO v_wallet FROM public.wallets WHERE user_id=auth.uid() AND currency=p_currency FOR UPDATE;
  IF NOT FOUND OR v_wallet.balance<p_amount THEN RAISE EXCEPTION 'Insufficient balance'; END IF;
  SELECT * INTO v_profile FROM public.profiles WHERE id=auth.uid();
  IF NOT FOUND OR v_profile.kyc_status<>'verified' THEN RAISE EXCEPTION 'Identity review must be approved before withdrawal'; END IF;
  IF length(trim(COALESCE(v_profile.bank_name,'')))<2 OR trim(COALESCE(v_profile.bank_account_number,''))!~'^[0-9]{4,40}$' THEN RAISE EXCEPTION 'Add your registered payout details in Settings before withdrawing'; END IF;
  SELECT COALESCE(sum(remaining),0) INTO v_locked FROM public.deposit_tranches
    WHERE user_id=auth.uid() AND currency=p_currency AND status='locked' AND maturity_date>now() AND remaining>0;
  v_withdrawable:=greatest(0,v_wallet.balance-v_locked);
  IF p_amount>v_withdrawable AND NOT p_confirm_break THEN RAISE EXCEPTION 'BREAKS_TRANCHE'; END IF;

  -- Liquid funds have no tranche. Only consume locked cycles for the portion
  -- that actually exceeds the withdrawable balance.
  v_growing_take:=greatest(0,p_amount-v_withdrawable);
  v_remaining:=v_growing_take;
  FOR v_tranche IN SELECT * FROM public.deposit_tranches
    WHERE user_id=auth.uid() AND currency=p_currency AND status='locked'
      AND maturity_date>now() AND remaining>0 ORDER BY maturity_date,created_at FOR UPDATE
  LOOP
    EXIT WHEN v_remaining<=0;
    v_take:=least(v_tranche.current_balance,v_remaining);
    UPDATE public.deposit_tranches SET
      remaining=greatest(0,remaining-least(remaining,v_take)),
      current_balance=greatest(0,current_balance-v_take),
      status=CASE WHEN current_balance-v_take<=0 THEN 'depleted' ELSE status END
    WHERE id=v_tranche.id;
    v_remaining:=v_remaining-v_take;
  END LOOP;
  IF v_remaining>0 THEN RAISE EXCEPTION 'Unable to allocate withdrawal'; END IF;
  v_penalty:=round(v_growing_take*.05,2); v_payout:=round(p_amount-v_penalty,2);
  INSERT INTO public.transactions(user_id,type,currency,amount,status,description)
  VALUES(auth.uid(),'withdrawal',p_currency,v_payout,'pending','Withdrawal request - '||v_profile.bank_name||' account ending '||right(v_profile.bank_account_number,4))
  RETURNING id INTO v_tx;
  IF v_penalty>0 THEN INSERT INTO public.transactions(user_id,type,currency,amount,status,reference,description) VALUES(auth.uid(),'fee',p_currency,v_penalty,'completed',v_tx::text,'Early withdrawal fee'); END IF;
  UPDATE public.wallets SET balance=balance-p_amount,updated_at=now() WHERE id=v_wallet.id;
  RETURN jsonb_build_object('grossAmount',p_amount,'penalty',v_penalty,'payoutAmount',v_payout,'accountLast4',right(v_profile.bank_account_number,4),'insuranceRepaid',v_repaid);
END; $$;

REVOKE ALL ON FUNCTION public.collect_insurance_repayment(uuid),public.insurance_eligibility(uuid),public.collect_insurance_when_funds_mature() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.insurance_eligibility(uuid) TO authenticated;
