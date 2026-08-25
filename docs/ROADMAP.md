# Roadmap — agreed 25 Aug 2026

Round 1 (A1 + B + C, shipped alongside this file) covered: the zero-dimension
RM/kg bug, RFQ subject prefix, BCC recipients + reminder, per-button signature
handling, bracketed refs, legend framed with horizontal rules, and removing
"Load example" from the RFQ tabs.

This file is the hand-off plan for the next rounds. Written so a fresh session
can continue without re-deriving context. Client said batching is fine — they
have not finished exploring (voice note 20 Aug 16:02).

---

## D1 — Two-role workflow (production submits, admin approves & sends)

**Client's words (20 Aug 17:20):** production downstairs types material/size/qty
(may or may not have a reference) and presses Send; admin upstairs receives it,
validates and corrects dimensions, then emails suppliers. Applies to both RFQ
Material and RFQ General.

### Schema (additive migration, e.g. supabase/migrations/003_workflow.sql)
- `rfqs.status text not null default 'draft'`
  check in ('draft','submitted','approved') — 'approved' meaning admin has
  taken it over; actual emailing stays a manual act.
- `rfqs.submitted_by text`, `rfqs.submitted_at timestamptz`,
  `rfqs.reviewed_by text`, `rfqs.reviewed_at timestamptz`.
- Roles: simplest robust option is a `profiles` table (user id → role
  'production' | 'admin') maintained by hand in the dashboard; do NOT trust
  client-side claims. RLS: production may insert/update only rfqs with
  status='draft' that they created; admin unrestricted. Email-generation UI
  hidden unless role='admin' (RLS is the real gate for data; the email button
  is client-side anyway since sending happens in Gmail).

### UI
- RfqEditor: for production users, replace "Generate RFQ email" with
  "Send to admin" (sets status='submitted'). Editing locks after submit.
- New admin queue view (could live on the RFQ tabs as a "Submitted" filter
  at the top of the sidebar): open → edit/correct → generates email as today.
  Approving stamps reviewed_by/at.
- Sidebar badges: Draft / Submitted / Approved.

### Open question for the client
Who exactly is "production" — separate logins per person, or one shared
production account? (Affects how many users to create and whether
submitted_by is meaningful.)

Estimate: 1–2 days including tests.

## D2 — Supplier quotation upload on Compare tab

**Client's words (20 Aug 15:49, 17:23):** when a supplier replies (PDF, email,
or photo), upload it and have the system pull the prices into the comparison.
Explicitly NOT wanted on RFQ tabs — typing stays there.

### Phase 1 — storage + viewing (no AI, no new accounts)
- Supabase Storage bucket `quotation-files` (private; RLS: authenticated).
- `quote_attachments` table: id, quote_id fk, path, filename, mime,
  uploaded_by, uploaded_at.
- CompareEditor: per-supplier "📎 Attach quotation" (accept pdf/jpg/png),
  list + open in new tab. Purchaser reads the file side-by-side and types
  prices as today.
- Estimate: half a day.

### Phase 2 — AI extraction (needs user's go-ahead on billing)
- Requires a vision-capable model API (e.g. Claude API) — API key + per-call
  cost. Key must live server-side: a Next.js route handler or Supabase Edge
  Function takes the storage path, sends the file, returns structured
  {supplier?, lines:[{desc?, thickness?, height?, length?, qty?, price}]}.
- Extraction populates the quote grid as a DRAFT for review — never saved
  without the purchaser confirming (client said "check一下" applies to
  everything; also extraction errors on handwritten/photographed quotes are
  likely).
- Prompt must understand the (00.00) / Ø notation and RM prices.
- Do not start without: which API account/billing, and expected volume.

## E — Security actions (not code)

- **E1 repo visibility:** repo must be PRIVATE — seed.sql contains all 49
  supplier emails, and git history retains them regardless of later removal.
  User flips it in GitHub → Settings → Danger Zone; verify anonymous
  `api.github.com/repos/HelixPointSolution/procurementdesk` returns 404.
  Vercel continues deploying private repos on the free tier.
- **E2 credential rotation (client action):** Gmail password and Supabase
  password were shared in plain-text WhatsApp messages (11–13 Aug chat).
  Recommend the client rotates both and uses a password manager. The
  Supabase publishable key is fine (public by design; RLS protects data).
- Never commit client feedback docs — .gitignore already blocks
  docs/feedback-*.md; keep those in the parent folder outside the repo.

## Backlog (from the 20 Aug audit, still open)

Search/filter on lists · export/print of comparisons · delivery-date &
quote-validity fields · multi-currency (a Singapore supplier is seeded — SGD
quotes will be summed as RM) · audit trail · sent-RFQ tracking · 200-row list
caps · 5 pre-existing "setState in effect" lint advisories.
