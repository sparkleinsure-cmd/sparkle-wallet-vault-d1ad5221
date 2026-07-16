# Fix Wallet Balance and Tranche Math Discrepancies

The user reported that after withdrawing "everything", some cycles remained and the total value math was incorrect. Research revealed that:
1. `requestWithdrawal` allows taking from the "growth" (incentives) of locked tranches, but since growth isn't yet in the wallet balance, it over-deducts from the principal in the wallet.
2. Breaking a tranche should forfeit rewards, but the current code allows keeping/withdrawing a portion of them.
3. The daily incentive script uses the initial deposit amount instead of the remaining principal, leading to accelerating growth on partially withdrawn tranches.

## Proposed Changes

### Wallet Logic

#### [wallet.functions.ts](file:///C:/Users/USER/Documents/1. Vert Corp Group (Pty) Ltd/Sparkle Insure/sparkle-wallet-vault-d1ad5221/src/lib/wallet.functions.ts)

- Update `requestWithdrawal` to properly forfeit rewards when breaking a tranche.
- Ensure `current_balance` is reset to `remaining` (principal) for all tranches being broken.
- This ensures that only principal is withdrawn and `wallets.balance` remains in sync with the sum of `remaining` principal in tranches.

```typescript
// Proposed change in requestWithdrawal:
    if (data.amount <= withdrawable) {
      remainingToWithdraw = 0;
    } else if (remainingToWithdraw > 0 && data.confirmBreak) {
      let lockedNeed = remainingToWithdraw;
      for (const tranche of locked) {
        if (lockedNeed <= 0) break;

        // Reset growth before taking from principal
        const principal = Number(tranche.remaining);
        await supabase
          .from("deposit_tranches")
          .update({ current_balance: principal })
          .eq("id", tranche.id);

        // Now currentValue and principal are equal (forfeited growth)
        const take = Math.min(principal, lockedNeed);
        await updateTranche(tranche, take);
        lockedNeed -= take;
      }
      remainingToWithdraw = Math.max(0, lockedNeed);
    }
```

### Database Logic

#### [NEW] [20260716190000_fix_incentive_calculation.sql](file:///C:/Users/USER/Documents/1. Vert Corp Group (Pty) Ltd/Sparkle Insure/sparkle-wallet-vault-d1ad5221/supabase/migrations/20260716190000_fix_incentive_calculation.sql)

- Update `apply_daily_tranche_incentive` to calculate 1% based on `remaining` principal instead of the initial `amount`.

```sql
CREATE OR REPLACE FUNCTION public.apply_daily_tranche_incentive()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  -- 1% daily incentive on REMAINING principal of locked tranches
  UPDATE public.deposit_tranches
  SET current_balance = current_balance + (remaining * 0.01)
  WHERE status = 'locked'
    AND maturity_date > now()
    AND remaining > 0;

  -- ... (rest of the maturation logic stays the same)
END;
$$;
```

## Verification Plan

### Automated Tests
- I will run the existing project build to ensure no regressions: `npm run build`
- I will verify the SQL function logic by manually checking the migration file.

### Manual Verification
- I will simulate a withdrawal that breaks a tranche and verify:
    1. The tranche `current_balance` is reset to `remaining` before the deduction.
    2. The `wallets.balance` is reduced by exactly the principal amount taken.
    3. The `Total Value` in the UI (calculated from `balance + growth`) remains consistent.
- I will verify the daily incentive script change by inspecting the SQL.
