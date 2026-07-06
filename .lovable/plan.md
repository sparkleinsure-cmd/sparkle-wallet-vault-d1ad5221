## Sparkle Insure — Full-Stack Wallet App

### Brand & Theme
Palette derived from the uploaded logo: **teal** (`oklch(0.62 0.10 210)` — primary) + **orange** (`oklch(0.68 0.18 45)` — accent), on off-white / deep-navy surfaces. Glassmorphism cards, subtle gradients, Inter + a refined display font (e.g. Sora). Full dark-mode tokens.

### Stack additions
- Enable **Lovable Cloud** (Supabase) for auth, DB, storage, server functions.
- PWA: `manifest.json`, standalone display, icon set (from logo), theme color, `<link>` tags in `__root.tsx`. Manifest-only (no service worker) per PWA skill.
- Capacitor-ready: add `capacitor.config.ts` scaffold, `public/` assets, `dist` output structure documented.

### Data model (Supabase migrations + grants + RLS)
- `profiles` (id → auth.users, first_name, surname, email, phone, account_id [8-char alnum, unique], primary_currency, kyc_status, proof_url)
- `wallets` (user_id, currency, balance) — multi-currency per user
- `transactions` (id, user_id, type: deposit|withdrawal|bonus, currency, amount, status, reference, created_at)
- `user_roles` + `app_role` enum + `has_role()` security-definer (admin role auto-granted via trigger for `sparkleinsure@gmail.com` or `@sparkleinsure.com` verified email)
- Storage bucket `kyc` for proof uploads (private, owner-read)
- Trigger: on signup → create profile + generate account_id + default ZAR wallet
- Seed 5 mock users via migration (profiles + wallets + transactions)

### Auth & KYC flow
- `/auth` — signup (First Name, Surname, Email, Phone, Proof upload) + login
- Signup uploads proof to storage, creates auth user, sends simulated OTP (store 6-digit code in `otp_codes` table, "sent" to email+phone — displayed as toast in dev)
- `/verify` — requires both email OTP + phone OTP entered before `kyc_status=verified`
- `_authenticated` layout blocks unverified users → redirects to `/verify`

### Dashboard (`/_authenticated/`)
- Balance card (formatted per primary currency via `Intl.NumberFormat`)
- Currency switcher (ZAR/NGN/GHS/USD) — switches which wallet is primary view
- Transaction list with search + type filter
- **Download Statement**: date range picker (7/30/90 days), generates CSV + PDF (jsPDF) client-side
- **Deposit** button → modal with currency dropdown + amount → Paystack inline (`https://js.paystack.co/v2/inline.js`), test public key placeholder (`pk_test_xxx`), on success calls server fn `creditDeposit` (verifies via reference, credits wallet, inserts transaction)
- **Withdraw** button → amount input → server fn sends email via Resend to `sparkleinsure@gmail.com` (or logs if no key), inserts pending transaction, UI shows 24h message

### Admin (`/_authenticated/admin`)
- Route-gated by `has_role(admin)` in beforeLoad
- Search users by account_id, list wallets, form to credit bonus (server fn writes transaction + updates wallet)

### Public routes / SEO
- `/` public landing with hero, features, CTA to signup — proper og tags, unique title
- `sitemap.xml` + `robots.txt`

### Technical notes
- All Paystack keys in `VITE_PAYSTACK_PUBLIC_KEY` (placeholder `pk_test_xxxxx`) — user swaps later
- Email sending uses Resend connector if available; otherwise server fn logs the notification (still returns success to UI)
- Money stored as integer minor units (cents) in DB; formatted on display
- Server fns use `requireSupabaseAuth`; admin fns re-check `has_role`

### Files (high-level)
- `supabase/migrations/*` — schema, grants, RLS, roles, seed
- `src/routes/index.tsx` — landing
- `src/routes/auth.tsx`, `verify.tsx`
- `src/routes/_authenticated/route.tsx` (managed), `index.tsx` (dashboard), `admin.tsx`
- `src/routes/sitemap[.]xml.ts`, `public/robots.txt`, `public/manifest.json`, icon PNGs
- `src/lib/wallet.functions.ts`, `src/lib/admin.functions.ts`, `src/lib/withdrawal.functions.ts`
- `src/components/*` — BalanceCard, TxTable, DepositDialog, WithdrawDialog, StatementDialog, CurrencySelect
- `src/styles.css` — teal/orange design tokens, glassmorphism utilities

Confirm and I'll build it end-to-end.
