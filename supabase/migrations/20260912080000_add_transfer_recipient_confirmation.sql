-- Resolve an exact transfer recipient before any funds move so the sender can
-- confirm the member's full name and Account ID. Do not expose phone or email.
CREATE OR REPLACE FUNCTION public.resolve_member_transfer_recipient_secure(
  p_recipient text
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
  v_recipient public.profiles%ROWTYPE;
  v_recipient_name text;
BEGIN
  IF v_sender_id IS NULL OR length(v_lookup) NOT BETWEEN 3 AND 50 THEN
    RAISE EXCEPTION 'Invalid recipient';
  END IF;

  SELECT * INTO v_recipient
  FROM public.profiles p
  WHERE upper(p.account_id)=upper(v_lookup)
     OR p.id::text=lower(v_lookup)
     OR (length(v_phone) BETWEEN 8 AND 15
       AND public.normalize_signup_phone(p.phone)=v_phone)
  ORDER BY CASE
    WHEN upper(p.account_id)=upper(v_lookup) OR p.id::text=lower(v_lookup) THEN 0
    ELSE 1
  END
  LIMIT 1;

  IF NOT FOUND THEN RAISE EXCEPTION 'Recipient was not found'; END IF;
  IF v_recipient.id=v_sender_id THEN
    RAISE EXCEPTION 'You cannot send funds to your own account';
  END IF;
  IF COALESCE(v_recipient.account_frozen,false) THEN
    RAISE EXCEPTION 'The recipient account cannot receive funds at this time';
  END IF;

  v_recipient_name:=COALESCE(
    NULLIF(concat_ws(' ',NULLIF(trim(v_recipient.first_name),''),NULLIF(trim(v_recipient.surname),'')),''),
    'Sparkle member'
  );

  RETURN jsonb_build_object(
    'recipientName',v_recipient_name,
    'recipientAccountId',v_recipient.account_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.resolve_member_transfer_recipient_secure(text)
  FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.resolve_member_transfer_recipient_secure(text)
  TO authenticated;
