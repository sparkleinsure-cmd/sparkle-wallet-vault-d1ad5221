
-- Cleanup: any locked tranche with no remaining principal should have no growth
UPDATE public.deposit_tranches
SET current_balance = 0
WHERE status = 'locked' AND remaining <= 0;

-- Optional: ensure current_balance is never less than remaining for locked tranches
UPDATE public.deposit_tranches
SET current_balance = remaining
WHERE status = 'locked' AND current_balance < remaining;
