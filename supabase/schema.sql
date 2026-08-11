-- ── Helix Point Procurement Desk v2 — database schema ────────────────
-- Run this in the Supabase SQL editor (Dashboard → SQL Editor → New query).
-- Safe to re-run: drops and recreates the v2 tables.
-- NOTE: does NOT touch the v1 tables (rounds, suppliers from the old app).
--       The old public."suppliers" table from v1 conflicts by name — v2 uses
--       its own tables below. Drop the old ones manually once migrated:
--         drop table if exists rounds;  -- old v1 table (sample data only)

create extension if not exists pgcrypto;

drop table if exists quote_items cascade;
drop table if exists quotes cascade;
drop table if exists rfq_items cascade;
drop table if exists rfqs cascade;
drop table if exists purchase_history cascade;
drop table if exists scorecards cascade;
drop table if exists supplier_materials cascade;
drop table if exists suppliers cascade;

-- ── Master data ──────────────────────────────────────────────────────
create table suppliers (
  id         uuid primary key default gen_random_uuid(),
  name       text not null unique,
  email      text,                       -- null = no email (e.g. "Walk in to buy")
  note       text not null default '',
  created_at timestamptz not null default now()
);

-- One row per (material group × supplier), mirroring the Excel Supplier List tab.
-- sort_order preserves the Excel's listing order inside a group: it is the
-- priority used to pick the top-3 suggested emails.
create table supplier_materials (
  id          uuid primary key default gen_random_uuid(),
  supplier_id uuid not null references suppliers(id) on delete cascade,
  category    text not null,             -- e.g. STAINLESS STEEL, ALU, TOOLS
  materials   text not null,             -- comma-separated keywords, e.g. "SUS 303, SUS 304, SUS 316, 316L"
  sort_order  int  not null default 0
);
create index on supplier_materials (category);

-- ── RFQs ─────────────────────────────────────────────────────────────
create table rfqs (
  id           uuid primary key default gen_random_uuid(),
  kind         text not null check (kind in ('material', 'general')),
  subject      text not null default '',           -- e.g. "RFQ SO26-08134"
  payment_term text not null default '',           -- supplier to fill; blank in email
  created_by   text not null default '',
  created_at   timestamptz not null default now()
);

create table rfq_items (
  id            uuid primary key default gen_random_uuid(),
  rfq_id        uuid not null references rfqs(id) on delete cascade,
  position      int  not null,
  material_type text,          -- material kind: e.g. "SS 304", "Alu 6061"
  description   text,          -- general kind: free text
  -- Dimensions stored as entered: "2.0", "(9.50)" = order size, "Ø4.00" = diameter.
  -- Notation must survive verbatim into the RFQ email (client requirement).
  thickness_raw text,
  height_raw    text,
  length_raw    text,
  qty           numeric,
  item_ref      text            -- e.g. "SO26-08134 (1)" — per-item, can differ per row
);
create index on rfq_items (rfq_id);

-- ── Supplier quotes per RFQ ──────────────────────────────────────────
create table quotes (
  id            uuid primary key default gen_random_uuid(),
  rfq_id        uuid not null references rfqs(id) on delete cascade,
  supplier_name text not null,
  supplier_id   uuid references suppliers(id) on delete set null,
  notes         text not null default '',   -- e.g. "No stock for item 2"
  created_at    timestamptz not null default now()
);
create index on quotes (rfq_id);

-- A missing row for (quote, rfq_item) means the supplier did not quote that
-- item ("no stock"). Quoted dims may differ from the inquiry — off-spec is
-- detected by comparison, never rejected at entry.
create table quote_items (
  id            uuid primary key default gen_random_uuid(),
  quote_id      uuid not null references quotes(id) on delete cascade,
  rfq_item_id   uuid not null references rfq_items(id) on delete cascade,
  thickness_raw text,
  height_raw    text,
  length_raw    text,
  qty           numeric,
  price         numeric,        -- RM per pc
  notes         text not null default '',
  unique (quote_id, rfq_item_id)
);

-- ── Purchase history (auto-filled on award, freely editable after) ───
create table purchase_history (
  id         uuid primary key default gen_random_uuid(),
  rfq_id     uuid references rfqs(id) on delete set null,
  date       date not null default current_date,
  ref        text not null default '',     -- RFQ subject, e.g. "RFQ SO26-08134"
  awarded_to text not null default '',     -- always the purchaser's choice
  total_rm   numeric,
  notes      text not null default '',
  created_by text not null default ''
);

-- ── Supplier scorecard (weighted 1–5 ratings) ────────────────────────
create table scorecards (
  id            uuid primary key default gen_random_uuid(),
  supplier_name text not null unique,
  scores        int[] not null default '{3,3,3,3,3}',  -- Price, Spec, Speed, Stock, Terms
  note          text not null default '',
  updated_by    text not null default '',
  updated_at    timestamptz not null default now()
);

-- ── Row Level Security: team members (authenticated) only ────────────
-- Public sign-ups should be DISABLED in Dashboard → Authentication → Providers.
-- Create team accounts manually (Dashboard → Authentication → Users → Add user).
do $$
declare t text;
begin
  foreach t in array array['suppliers','supplier_materials','rfqs','rfq_items',
                           'quotes','quote_items','purchase_history','scorecards']
  loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists team_all on %I', t);
    execute format(
      'create policy team_all on %I for all to authenticated using (true) with check (true)', t);
  end loop;
end $$;
