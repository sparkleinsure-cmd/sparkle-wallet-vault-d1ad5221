-- The currency switcher has been removed. Keep every profile on the ZAR
-- wallet without converting or relabelling balances or transaction history.
CREATE OR REPLACE FUNCTION public.enforce_zar_primary_currency()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.primary_currency := 'ZAR';
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.enforce_zar_primary_currency()
  FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS enforce_zar_primary_currency ON public.profiles;
CREATE TRIGGER enforce_zar_primary_currency
BEFORE INSERT OR UPDATE OF primary_currency ON public.profiles
FOR EACH ROW EXECUTE FUNCTION public.enforce_zar_primary_currency();

ALTER TABLE public.profiles ALTER COLUMN primary_currency SET DEFAULT 'ZAR';
UPDATE public.profiles SET primary_currency = 'ZAR'
WHERE primary_currency IS DISTINCT FROM 'ZAR';
