# Helix Point — Procurement Desk v2

Rebuild of the v1 tool (workshoptool-psi.vercel.app) implementing the client's
Excel improvement spec ("Procurement Desk (1).xlsx"): Next.js + Supabase
(Auth + Postgres + RLS), deployed on Vercel.

## Tabs (mirroring the Excel)

1. **RFQ Material** — per-item Material Type / Thickness / Height / Length / Qty / per-item Ref.
   Suggested supplier emails per item from the Supplier List. Generates a plain-text RFQ
   email (Copy / Open in Gmail / Mail app). Notation preserved verbatim:
   `(9.50)` = order size · `9.50` = finishing size (+5mm max allowance) · `Ø4.00` = diameter.
2. **RFQ General** — non-material items: Description / Qty / Ref.
3. **Quote Comparison (Material)** — per-supplier quotes; suppliers may quote different
   dims (off-spec, flagged on every dimension) or skip items. Charts: As Quoted,
   Normalised RM/kg, Spec Match. Claude's Choice (recommendation) vs Purchaser's Choice
   (final) → Award writes Purchase History.
4. **Quote Comparison (General)** — simple totals comparison + award.
5. **Supplier Scorecard** — weighted 1–5 ratings, team-shared.
6. **Supplier List** — master data: material groups → ordered suppliers (order = suggestion priority).
7. **Purchase History** — auto-filled on award, fully editable.

Weight formulas (from the Excel): rect `T×H×L×0.000008`, round `Ø²×L×0.0000066`
(steel constants, scaled by material density; plastics get no RM/kg).
Note: the Excel's Ø50×200 example says "303 kg" — that's a decimal typo; correct is 3.3 kg.

## Setup (one-time)

1. **Create a Supabase project** at supabase.com (the v1 project no longer exists).
2. **Run the SQL**: Dashboard → SQL Editor → paste & run `supabase/schema.sql`,
   then `supabase/seed.sql` (loads the ~50 suppliers / 22 material groups from the Excel).
3. **Disable public sign-ups**: Dashboard → Authentication → Sign In / Up →
   turn OFF "Allow new users to sign up".
4. **Create team accounts**: Dashboard → Authentication → Users → Add user
   (email + password, "Auto Confirm User" on).
5. **Configure keys**: copy Project URL + publishable (anon) key from
   Dashboard → Project Settings → API into `.env.local` (see placeholders).

## Develop

```bash
npm install
npm run dev        # http://localhost:3000
npx vitest run     # domain-logic tests (dimension notation, weights, matching, comparison)
```

## Deploy (Vercel)

1. Push this repo to GitHub and import it in Vercel (framework auto-detected).
2. Add the two `NEXT_PUBLIC_SUPABASE_*` env vars in Vercel → Project → Settings →
   Environment Variables.
3. After the v2 URL is live, take down / password the old v1 deployment — its
   config exposes a key to a now-dead project, but the page itself is stale.

## Security model

- The publishable (anon) key ships to the browser — that is by design.
- RLS on every table: `anon` sees nothing; only `authenticated` (team logins) read/write.
- Keep public sign-ups disabled or anyone could self-register and see quote prices.
