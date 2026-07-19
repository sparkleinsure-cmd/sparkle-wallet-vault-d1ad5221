-- Keep early-withdrawal penalties as separate, visible ledger entries.
ALTER TYPE public.tx_type ADD VALUE IF NOT EXISTS 'fee';
