-- Members can send only liquid/withdrawable funds to another registered
-- member. Transfers are atomic and request-keyed, and never consume locked
-- growth funds. Selected members are routed to an administrator for approval.
CREATE TABLE public.member_wallet_transfers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid NOT NULL UNIQUE,
  sender_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  recipient_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  currency text NOT NULL CHECK (currency IN ('ZAR','USD')),
  amount numeric(18,2) NOT NULL CHECK (amount >= 0.01),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','completed','declined')),
  sender_transaction_id uuid UNIQUE REFERENCES public.transactions(id) ON DELETE SET NULL,
  recipient_transaction_id uuid UNIQUE REFERENCES public.transactions(id) ON DELETE SET NULL,
  sender_withdrawable_after numeric(18,2),
  reviewed_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  reviewed_at timestamptz,
  review_note text,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (sender_id<>recipient_id)
);

CREATE INDEX member_wallet_transfers_sender_idx ON public.member_wallet_transfers(sender_id,created_at DESC);
CREATE INDEX member_wallet_transfers_recipient_idx ON public.member_wallet_transfers(recipient_id,created_at DESC);
CREATE INDEX member_wallet_transfers_pending_idx ON public.member_wallet_transfers(created_at) WHERE status='pending';
ALTER TABLE public.member_wallet_transfers ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.member_wallet_transfers FROM PUBLIC,anon,authenticated;
GRANT ALL ON public.member_wallet_transfers TO service_role;

CREATE TABLE public.member_transfer_review_users (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  reason text NOT NULL,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.member_transfer_review_users ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.member_transfer_review_users FROM PUBLIC,anon,authenticated;
GRANT ALL ON public.member_transfer_review_users TO service_role;

-- Store immutable user IDs so later name edits do not remove the restriction.
INSERT INTO public.member_transfer_review_users(user_id,reason)
SELECT p.id,'Transfer approval required by administrator'
FROM public.profiles p
WHERE lower(regexp_replace(trim(concat_ws(' ',p.first_name,p.surname)),'\s+',' ','g'))
  IN ('sipho mkhonza','gift hadebe','amanda memela')
   OR upper(p.account_id) IN ('7SUUMZUK','7Z24UY26')
ON CONFLICT(user_id) DO NOTHING;

CREATE OR REPLACE FUNCTION public.complete_member_wallet_transfer(p_transfer_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=public
AS $$
DECLARE
  v_operation public.member_wallet_transfers%ROWTYPE;
  v_sender public.profiles%ROWTYPE;
  v_recipient public.profiles%ROWTYPE;
  v_sender_wallet public.wallets%ROWTYPE;
  v_recipient_wallet public.wallets%ROWTYPE;
  v_locked numeric:=0;
  v_withdrawable numeric:=0;
  v_withdrawable_after numeric:=0;
  v_remaining numeric:=0;
  v_take numeric:=0;
  v_tranche public.deposit_tranches%ROWTYPE;
  v_sender_tx uuid;
  v_recipient_tx uuid;
  v_sender_name text;
  v_recipient_name text;
BEGIN
  SELECT * INTO v_operation FROM public.member_wallet_transfers
  WHERE id=p_transfer_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Transfer request not found'; END IF;
  IF v_operation.status='declined' THEN RAISE EXCEPTION 'Transfer request was declined'; END IF;

  SELECT * INTO v_sender FROM public.profiles WHERE id=v_operation.sender_id;
  SELECT * INTO v_recipient FROM public.profiles WHERE id=v_operation.recipient_id;
  IF v_sender.id IS NULL OR v_recipient.id IS NULL THEN RAISE EXCEPTION 'Transfer member profile not found'; END IF;
  v_sender_name:=COALESCE(NULLIF(concat_ws(' ',NULLIF(trim(v_sender.first_name),''),NULLIF(trim(v_sender.surname),'')),''),'Sparkle member');
  v_recipient_name:=COALESCE(NULLIF(concat_ws(' ',NULLIF(trim(v_recipient.first_name),''),NULLIF(trim(v_recipient.surname),'')),''),'Sparkle member');

  IF v_operation.status='completed' THEN
    RETURN jsonb_build_object(
      'ok',true,'replayed',true,'status','completed','transferId',v_operation.id,
      'amount',v_operation.amount,'currency',v_operation.currency,
      'recipientAccountId',v_recipient.account_id,'recipientName',v_recipient_name,
      'withdrawableAfter',v_operation.sender_withdrawable_after
    );
  END IF;
  IF COALESCE(v_sender.account_frozen,false) THEN RAISE EXCEPTION 'Sender account is frozen while a compliance review is in progress'; END IF;
  IF COALESCE(v_recipient.account_frozen,false) THEN RAISE EXCEPTION 'The recipient account cannot receive funds at this time'; END IF;

  PERFORM public.settle_due_tranches_for_user(v_operation.sender_id);
  PERFORM id FROM public.wallets
  WHERE user_id IN (v_operation.sender_id,v_operation.recipient_id) AND currency=v_operation.currency
  ORDER BY user_id FOR UPDATE;

  SELECT * INTO v_sender_wallet FROM public.wallets
  WHERE user_id=v_operation.sender_id AND currency=v_operation.currency;
  IF NOT FOUND THEN RAISE EXCEPTION 'Sender wallet not found'; END IF;
  SELECT * INTO v_recipient_wallet FROM public.wallets
  WHERE user_id=v_operation.recipient_id AND currency=v_operation.currency;
  IF NOT FOUND THEN RAISE EXCEPTION 'Recipient wallet not found'; END IF;

  PERFORM id FROM public.deposit_tranches
  WHERE user_id=v_operation.sender_id AND currency=v_operation.currency
    AND status IN ('locked','matured') AND remaining>0
  ORDER BY id FOR UPDATE;
  SELECT COALESCE(sum(remaining),0) INTO v_locked FROM public.deposit_tranches
  WHERE user_id=v_operation.sender_id AND currency=v_operation.currency
    AND status='locked' AND remaining>0;
  v_withdrawable:=greatest(0,v_sender_wallet.balance-v_locked);
  IF v_operation.amount>v_withdrawable THEN
    RAISE EXCEPTION 'Transfer exceeds the sender available withdrawable balance of % %',
      v_operation.currency,trim(to_char(v_withdrawable,'FM999G999G999G990D00'));
  END IF;

  v_remaining:=v_operation.amount;
  FOR v_tranche IN SELECT * FROM public.deposit_tranches
    WHERE user_id=v_operation.sender_id AND currency=v_operation.currency
      AND status='matured' AND remaining>0
    ORDER BY maturity_date,created_at FOR UPDATE
  LOOP
    EXIT WHEN v_remaining<=0;
    v_take:=least(v_tranche.remaining,v_remaining);
    UPDATE public.deposit_tranches
    SET remaining=greatest(0,remaining-v_take),current_balance=greatest(0,current_balance-v_take),
        status=CASE WHEN remaining-v_take<=0 THEN 'liquidated' ELSE status END
    WHERE id=v_tranche.id;
    v_remaining:=v_remaining-v_take;
  END LOOP;

  UPDATE public.wallets SET balance=balance-v_operation.amount,updated_at=now()
  WHERE id=v_sender_wallet.id AND balance-v_operation.amount>=v_locked;
  IF NOT FOUND THEN RAISE EXCEPTION 'Withdrawable balance changed; retry the transfer'; END IF;
  UPDATE public.wallets SET balance=balance+v_operation.amount,updated_at=now()
  WHERE id=v_recipient_wallet.id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Recipient wallet changed; retry the transfer'; END IF;

  v_withdrawable_after:=v_withdrawable-v_operation.amount;
  -- Amounts remain positive to satisfy the existing ledger constraint;
  -- description and reference carry the debit/credit direction.
  INSERT INTO public.transactions(user_id,type,currency,amount,status,description,reference)
  VALUES(v_operation.sender_id,'transfer',v_operation.currency,v_operation.amount,'completed',
    'Sent to '||v_recipient_name||' ('||v_recipient.account_id||')','PEER-SENT-'||v_operation.request_id::text)
  RETURNING id INTO v_sender_tx;
  INSERT INTO public.transactions(user_id,type,currency,amount,status,description,reference)
  VALUES(v_operation.recipient_id,'transfer',v_operation.currency,v_operation.amount,'completed',
    'Received from '||v_sender_name||' ('||v_sender.account_id||')','PEER-RECEIVED-'||v_operation.request_id::text)
  RETURNING id INTO v_recipient_tx;

  UPDATE public.member_wallet_transfers SET status='completed',sender_transaction_id=v_sender_tx,
    recipient_transaction_id=v_recipient_tx,sender_withdrawable_after=v_withdrawable_after,completed_at=now()
  WHERE id=v_operation.id;
  PERFORM public.enqueue_withdrawable_credit_email(
    'peer-transfer:'||v_operation.request_id::text,v_operation.recipient_id,v_operation.currency,
    v_operation.amount,'Funds received from '||v_sender_name||' ('||v_sender.account_id||')'
  );
  RETURN jsonb_build_object(
    'ok',true,'replayed',false,'status','completed','transferId',v_operation.id,
    'amount',v_operation.amount,'currency',v_operation.currency,
    'recipientAccountId',v_recipient.account_id,'recipientName',v_recipient_name,
    'withdrawableAfter',v_withdrawable_after
  );
END;
$$;
REVOKE ALL ON FUNCTION public.complete_member_wallet_transfer(uuid) FROM PUBLIC,anon,authenticated;

CREATE OR REPLACE FUNCTION public.send_member_withdrawable_funds_secure(
  p_recipient text,p_currency text,p_amount numeric,p_request_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=public
AS $$
DECLARE
  v_sender_id uuid:=auth.uid();
  v_lookup text:=trim(COALESCE(p_recipient,''));
  v_phone text:=public.normalize_signup_phone(p_recipient);
  v_amount numeric:=round(p_amount,2);
  v_sender public.profiles%ROWTYPE;
  v_recipient public.profiles%ROWTYPE;
  v_operation public.member_wallet_transfers%ROWTYPE;
  v_claimed_request uuid;
  v_requires_review boolean:=false;
  v_recipient_name text;
BEGIN
  IF v_sender_id IS NULL OR p_request_id IS NULL OR p_currency NOT IN ('ZAR','USD')
     OR v_amount IS NULL OR v_amount<0.01 OR v_amount>10000000
     OR length(v_lookup) NOT BETWEEN 3 AND 50 THEN RAISE EXCEPTION 'Invalid transfer request'; END IF;
  SELECT * INTO v_sender FROM public.profiles WHERE id=v_sender_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Sender profile not found'; END IF;
  IF COALESCE(v_sender.account_frozen,false) THEN RAISE EXCEPTION 'Your account is frozen while a compliance review is in progress'; END IF;

  SELECT * INTO v_recipient FROM public.profiles p
  WHERE upper(p.account_id)=upper(v_lookup)
     OR p.id::text=lower(v_lookup)
     OR (length(v_phone) BETWEEN 8 AND 15 AND public.normalize_signup_phone(p.phone)=v_phone)
  ORDER BY CASE WHEN upper(p.account_id)=upper(v_lookup) OR p.id::text=lower(v_lookup) THEN 0 ELSE 1 END LIMIT 1;
  IF NOT FOUND THEN RAISE EXCEPTION 'Recipient was not found'; END IF;
  IF v_recipient.id=v_sender_id THEN RAISE EXCEPTION 'You cannot send funds to your own account'; END IF;
  IF COALESCE(v_recipient.account_frozen,false) THEN RAISE EXCEPTION 'The recipient account cannot receive funds at this time'; END IF;
  v_recipient_name:=COALESCE(NULLIF(concat_ws(' ',NULLIF(trim(v_recipient.first_name),''),NULLIF(trim(v_recipient.surname),'')),''),'Sparkle member');
  SELECT EXISTS(SELECT 1 FROM public.member_transfer_review_users WHERE user_id=v_sender_id)
  INTO v_requires_review;

  INSERT INTO public.member_wallet_transfers(request_id,sender_id,recipient_id,currency,amount)
  VALUES(p_request_id,v_sender_id,v_recipient.id,p_currency,v_amount)
  ON CONFLICT(request_id) DO NOTHING RETURNING request_id INTO v_claimed_request;
  IF v_claimed_request IS NULL THEN
    SELECT * INTO v_operation FROM public.member_wallet_transfers WHERE request_id=p_request_id FOR UPDATE;
    IF v_operation.sender_id IS DISTINCT FROM v_sender_id OR v_operation.recipient_id IS DISTINCT FROM v_recipient.id
       OR v_operation.currency IS DISTINCT FROM p_currency OR v_operation.amount IS DISTINCT FROM v_amount THEN
      RAISE EXCEPTION 'This request identifier was already used for different transfer details';
    END IF;
    IF v_operation.status='declined' THEN RAISE EXCEPTION 'This transfer was declined'; END IF;
    IF v_operation.status='pending' THEN
      RETURN jsonb_build_object('ok',true,'replayed',true,'status','pending','transferId',v_operation.id,
        'amount',v_operation.amount,'currency',v_operation.currency,'recipientAccountId',v_recipient.account_id,
        'recipientName',v_recipient_name,'withdrawableAfter',NULL);
    END IF;
    RETURN public.complete_member_wallet_transfer(v_operation.id);
  END IF;
  IF v_requires_review THEN
    RETURN jsonb_build_object('ok',true,'replayed',false,'status','pending','transferId',(
      SELECT id FROM public.member_wallet_transfers WHERE request_id=p_request_id),
      'amount',v_amount,'currency',p_currency,'recipientAccountId',v_recipient.account_id,
      'recipientName',v_recipient_name,'withdrawableAfter',NULL);
  END IF;
  RETURN public.complete_member_wallet_transfer((SELECT id FROM public.member_wallet_transfers WHERE request_id=p_request_id));
END;
$$;
REVOKE ALL ON FUNCTION public.send_member_withdrawable_funds_secure(text,text,numeric,uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.send_member_withdrawable_funds_secure(text,text,numeric,uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.admin_list_pending_member_transfers()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=public
AS $$
DECLARE v_result jsonb;
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(),'admin') THEN RAISE EXCEPTION 'Forbidden'; END IF;
  SELECT jsonb_build_object('transfers',COALESCE(jsonb_agg(jsonb_build_object(
    'id',t.id,'amount',t.amount,'currency',t.currency,'createdAt',t.created_at,
    'senderId',sender.id,'senderName',concat_ws(' ',sender.first_name,sender.surname),
    'senderAccountId',sender.account_id,'senderEmail',sender.email,'senderPhone',sender.phone,
    'recipientId',recipient.id,'recipientName',concat_ws(' ',recipient.first_name,recipient.surname),
    'recipientAccountId',recipient.account_id,'recipientEmail',recipient.email,'recipientPhone',recipient.phone
  ) ORDER BY t.created_at),'[]'::jsonb)) INTO v_result
  FROM public.member_wallet_transfers t
  JOIN public.profiles sender ON sender.id=t.sender_id
  JOIN public.profiles recipient ON recipient.id=t.recipient_id
  WHERE t.status='pending';
  RETURN v_result;
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_review_member_transfer_secure(
  p_transfer_id uuid,p_decision text,p_note text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=public
AS $$
DECLARE v_status text;
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(),'admin') THEN RAISE EXCEPTION 'Forbidden'; END IF;
  IF p_decision NOT IN ('approved','declined') THEN RAISE EXCEPTION 'Invalid transfer decision'; END IF;
  SELECT status INTO v_status FROM public.member_wallet_transfers WHERE id=p_transfer_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Transfer request not found'; END IF;
  IF v_status<>'pending' THEN RAISE EXCEPTION 'Transfer request has already been reviewed'; END IF;
  IF p_decision='declined' THEN
    UPDATE public.member_wallet_transfers SET status='declined',reviewed_by=auth.uid(),reviewed_at=now(),
      review_note=NULLIF(trim(COALESCE(p_note,'')),'') WHERE id=p_transfer_id;
    RETURN jsonb_build_object('ok',true,'status','declined','transferId',p_transfer_id);
  END IF;
  UPDATE public.member_wallet_transfers SET reviewed_by=auth.uid(),reviewed_at=now(),
    review_note=NULLIF(trim(COALESCE(p_note,'')),'') WHERE id=p_transfer_id;
  RETURN public.complete_member_wallet_transfer(p_transfer_id);
END;
$$;
REVOKE ALL ON FUNCTION public.admin_list_pending_member_transfers() FROM PUBLIC,anon;
REVOKE ALL ON FUNCTION public.admin_review_member_transfer_secure(uuid,text,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.admin_list_pending_member_transfers() TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_review_member_transfer_secure(uuid,text,text) TO authenticated;
