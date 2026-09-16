-- One lifetime reminder per member, including existing members older than 48 hours.
-- Reservations are never retried: an interrupted provider request may have sent.
CREATE TABLE public.welcome_bonus_sms_reminders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE,
  recipient_phone text NOT NULL,
  status text NOT NULL DEFAULT 'processing'
    CHECK (status IN ('processing','sent','failed','unknown','skipped')),
  attempted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  sent_at timestamptz,
  provider_message_id text,
  error text,
  first_login_at timestamptz,
  first_active_at timestamptz
);
ALTER TABLE public.welcome_bonus_sms_reminders ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.welcome_bonus_sms_reminders FROM anon, authenticated;
GRANT ALL ON public.welcome_bonus_sms_reminders TO service_role;
CREATE INDEX welcome_bonus_sms_report_idx ON public.welcome_bonus_sms_reminders(attempted_at DESC);

CREATE FUNCTION public.claim_welcome_bonus_sms_reminder()
RETURNS SETOF public.welcome_bonus_sms_reminders
LANGUAGE sql SECURITY DEFINER SET search_path=public AS $$
  INSERT INTO public.welcome_bonus_sms_reminders(user_id,recipient_phone)
  SELECT p.id, COALESCE(p.phone,'')
  FROM public.profiles p JOIN auth.users u ON u.id=p.id
  WHERE u.created_at < now()-interval '48 hours'
    AND u.deleted_at IS NULL
    AND (u.banned_until IS NULL OR u.banned_until <= now())
    AND NOT COALESCE(p.account_frozen,false)
    AND p.welcome_bonus_credited_at IS NULL
    AND NOT EXISTS (SELECT 1 FROM public.transactions t
      WHERE t.user_id=p.id AND t.reference='WELCOME-'||p.id::text)
    AND NOT EXISTS (SELECT 1 FROM public.welcome_bonus_sms_reminders r WHERE r.user_id=p.id)
    -- Match the existing welcome-bonus identity eligibility rules.
    AND NOT EXISTS (
      SELECT 1 FROM public.signup_risk_signals s
      JOIN public.signup_identity_history h
        ON h.signal_type=s.signal_type AND h.signal_hash=s.signal_hash
      WHERE s.user_id=p.id AND (h.first_user_id<>p.id OR h.bonus_claimed_at IS NOT NULL)
        AND (s.signal_type IN ('email','phone') OR
          (s.signal_type='installation' AND NOT EXISTS (
            SELECT 1 FROM public.bonus_test_installations t WHERE t.signal_hash=s.signal_hash)))
    )
  ORDER BY u.created_at,p.id LIMIT 1
  FOR UPDATE OF p SKIP LOCKED
  ON CONFLICT (user_id) DO NOTHING
  RETURNING *;
$$;

CREATE FUNCTION public.complete_welcome_bonus_sms_reminder(
  p_id uuid, p_status text, p_provider_message_id text DEFAULT NULL, p_error text DEFAULT NULL
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
  IF p_status NOT IN ('sent','failed','unknown','skipped') THEN
    RAISE EXCEPTION 'Invalid reminder result';
  END IF;
  UPDATE public.welcome_bonus_sms_reminders
  SET status=p_status,
      sent_at=CASE WHEN p_status='sent' THEN clock_timestamp() END,
      provider_message_id=left(p_provider_message_id,200), error=left(p_error,500)
  WHERE id=p_id AND status IN ('processing','unknown');
END;
$$;

-- Presence is authenticated activity, not necessarily a new login.
-- Preserve these as separate measures and only expose them for accepted SMSes.
CREATE FUNCTION public.track_welcome_bonus_sms_activity()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
  UPDATE public.welcome_bonus_sms_reminders r
  SET first_active_at=COALESCE(r.first_active_at,NEW.last_seen_at),
      first_login_at=COALESCE(r.first_login_at,
        (SELECT u.last_sign_in_at FROM auth.users u
         WHERE u.id=NEW.user_id AND u.last_sign_in_at>r.sent_at))
  WHERE r.user_id=NEW.user_id AND r.status='sent'
    AND NEW.last_seen_at>r.sent_at
    AND (r.first_active_at IS NULL OR r.first_login_at IS NULL);
  RETURN NEW;
END;
$$;
CREATE TRIGGER track_welcome_bonus_sms_activity
AFTER INSERT OR UPDATE OF last_seen_at ON public.user_presence
FOR EACH ROW EXECUTE FUNCTION public.track_welcome_bonus_sms_activity();

CREATE FUNCTION public.admin_welcome_bonus_sms_report(p_page integer DEFAULT 0)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
  WITH report AS (
    SELECT r.id,r.recipient_phone,r.attempted_at,r.sent_at,r.error,
      CASE WHEN r.status='processing' AND r.attempted_at<now()-interval '15 minutes'
        THEN 'unknown' ELSE r.status END AS status,
      p.account_id, concat_ws(' ',p.first_name,p.surname) AS name,u.created_at AS signed_up_at,
      CASE WHEN r.status='sent' THEN COALESCE(r.first_login_at,
        CASE WHEN u.last_sign_in_at>r.sent_at THEN u.last_sign_in_at END) END AS first_login_at,
      CASE WHEN r.status='sent' THEN r.first_active_at END AS first_active_at,
      CASE WHEN r.status='sent' AND p.welcome_bonus_credited_at>r.sent_at
        THEN p.welcome_bonus_credited_at END AS claimed_at
    FROM public.welcome_bonus_sms_reminders r
    JOIN public.profiles p ON p.id=r.user_id JOIN auth.users u ON u.id=r.user_id
  ), page AS (
    SELECT * FROM report ORDER BY attempted_at DESC,id
    LIMIT 25 OFFSET (greatest(0,least(COALESCE(p_page,0),100000))*25)
  )
  SELECT jsonb_build_object(
    'rows',COALESCE((SELECT jsonb_agg(to_jsonb(page) ORDER BY attempted_at DESC,id) FROM page),'[]'::jsonb),
    'total',(SELECT count(*) FROM report),
    'sent',(SELECT count(*) FROM report WHERE status='sent'),
    'loggedIn',(SELECT count(*) FROM report WHERE first_login_at IS NOT NULL),
    'active',(SELECT count(*) FROM report WHERE first_active_at IS NOT NULL),
    'claimed',(SELECT count(*) FROM report WHERE claimed_at IS NOT NULL),
    'needsAttention',(SELECT count(*) FROM report WHERE status IN ('failed','unknown','skipped'))
  );
$$;

REVOKE ALL ON FUNCTION public.claim_welcome_bonus_sms_reminder() FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.complete_welcome_bonus_sms_reminder(uuid,text,text,text) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.track_welcome_bonus_sms_activity() FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.admin_welcome_bonus_sms_report(integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.claim_welcome_bonus_sms_reminder() TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_welcome_bonus_sms_reminder(uuid,text,text,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_welcome_bonus_sms_report(integer) TO service_role;

-- The existing scheduled withdrawable-credit-email worker also processes this queue.
