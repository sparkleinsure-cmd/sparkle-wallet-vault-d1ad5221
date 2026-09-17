-- Extend admin_list_recruiter_applications to include live recruit count and period volume progress
CREATE OR REPLACE FUNCTION public.admin_list_recruiter_applications()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_result jsonb;
  v_period_start date := public.recruiter_period_start(now());
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(), 'admin'::public.app_role) THEN
    RAISE EXCEPTION 'Forbidden';
  END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'id', a.id, 'userId', a.user_id, 'status', a.status,
      'appliedAt', a.applied_at, 'approvedAt', a.approved_at,
      'reviewNote', a.review_note, 'agreementVersion', a.agreement_version,
      'bankName', a.bank_name_snapshot, 'bankAccountLast4', a.bank_account_last4,
      'accountId', p.account_id, 'firstName', p.first_name, 'surname', p.surname,
      'email', p.email, 'phone', p.phone,
      'recruitsCount', COALESCE((
        SELECT count(*)::integer FROM public.referrals r WHERE r.referrer_id = a.user_id
      ), 0),
      'qualifyingRecruits', COALESCE((
        SELECT count(*)::integer
        FROM public.referrals r
        JOIN public.transactions t ON t.id = r.first_deposit_transaction_id
        JOIN public.deposit_tranches d ON d.transaction_id = t.id AND d.source = 'deposit'
        WHERE r.referrer_id = a.user_id
          AND a.approved_at IS NOT NULL
          AND r.created_at >= a.approved_at
          AND t.status = 'completed' AND t.currency = 'ZAR' AND t.amount >= 1000
          AND d.growth_cycle_code = '30d'
          AND public.recruiter_period_start(d.created_at) = v_period_start
      ), 0),
      'qualifyingDeposits', COALESCE((
        SELECT sum(t.amount)
        FROM public.referrals r
        JOIN public.transactions t ON t.id = r.first_deposit_transaction_id
        JOIN public.deposit_tranches d ON d.transaction_id = t.id AND d.source = 'deposit'
        WHERE r.referrer_id = a.user_id
          AND a.approved_at IS NOT NULL
          AND r.created_at >= a.approved_at
          AND t.status = 'completed' AND t.currency = 'ZAR' AND t.amount >= 1000
          AND d.growth_cycle_code = '30d'
          AND public.recruiter_period_start(d.created_at) = v_period_start
      ), 0)
    ) ORDER BY a.applied_at DESC), '[]'::jsonb)
  INTO v_result
  FROM public.recruiter_applications a
  JOIN public.profiles p ON p.id = a.user_id;
  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_list_recruiter_applications() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_list_recruiter_applications() TO authenticated;
