# Fix Wallet Math and Enable Growth Realization on Early Withdrawal

The user reported that even after "withdrawing everything", some cycles and growth remained. Analysis shows:
1. Users can currently only withdraw principal from locked tranches; any accrued growth (1% daily) remains "trapped" in the tranche if not forfeited.
2. Older logic allowed withdrawing principal while leaving growth behind, creating "ghost" balances.
3. Users expect to be able to withdraw the *full* current value (principal + growth) when they choose to break a cycle (subject to an admin-applied penalty later).

## Proposed Changes

### Wallet Logic

#### [wallet.functions.ts](file:///C:/Users/USER/Documents/1. Vert Corp Group (Pty) Ltd/Sparkle Insure/sparkle-wallet-vault-d1ad5221/src/lib/wallet.functions.ts)

- Update `requestWithdrawal` to allow taking from the full `current_balance` of locked tranches if `confirmBreak` is true.
- "Realize" any growth taken by adding it to the `wallets.balance` before the final deduction.
- Add a transaction record for realized growth to maintain a clear audit trail.
- Ensure that if a tranche is "emptied" (principal taken), any remaining growth is also cleared.

### Database Logic

#### [NEW] [20260716203000_cleanup_ghost_balances.sql](file:///C:/Users/USER/Documents/1. Vert Corp Group (Pty) Ltd/Sparkle Insure/sparkle-wallet-vault-d1ad5221/supabase/migrations/20260716203000_cleanup_ghost_balances.sql)

- Sync `current_balance` with `remaining` for all locked tranches where principal has been fully withdrawn to remove "ghost" growth.

```sql
-- Cleanup: any locked tranche with no remaining principal should have no growth
UPDATE public.deposit_tranches
SET current_balance = 0
WHERE status = 'locked' AND remaining <= 0;
```

## Verification Plan

### Automated Tests
- Run `npm run build` to ensure no regressions.

### Manual Verification
- Simulate a withdrawal that exceeds principal but is within current balance (principal + growth).
- Verify:
    1. Wallet balance is correctly adjusted (Growth added, then total amount deducted).
    2. A "Growth realization" transaction appears in the history.
    3. The tranche is correctly updated or removed.
    4. The "Total Value" math remains solid.
