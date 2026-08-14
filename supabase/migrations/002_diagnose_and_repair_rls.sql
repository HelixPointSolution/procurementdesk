-- ── Diagnose and repair: "the app shows no data but the SQL ran fine" ──
--
-- Symptom: every list in the app is empty and NO error is displayed.
-- An empty result with no error is what Postgres returns when RLS is enabled
-- on a table but no policy grants the caller access — reads are silently
-- filtered to zero rows rather than rejected. The SQL Editor runs as a
-- superuser and bypasses RLS entirely, which is why the seed reports success
-- while the app sees nothing.
--
-- Additive and non-destructive: creates no tables, deletes no rows.
-- Run the whole file in Supabase → SQL Editor.

-- ── STEP 1: diagnose ─────────────────────────────────────────────────
-- Read this result before anything else.
select
  (select count(*) from suppliers)               as supplier_rows,      -- expect 50
  (select count(*) from supplier_materials)      as membership_rows,    -- expect 86
  (select count(*) from pg_policies
     where schemaname = 'public' and tablename = 'suppliers')  as supplier_policies,
  (select count(*) from pg_policies
     where schemaname = 'public'
       and tablename in ('suppliers','supplier_materials','rfqs','rfq_items',
                         'quotes','quote_items','purchase_history','scorecards'))
                                                 as total_policies;     -- expect 8

--  supplier_rows = 0  → the seed data is gone. Re-run seed.sql.
--                       (Most likely cause: schema.sql was run AFTER seed.sql;
--                        schema.sql drops every table.)
--  supplier_rows = 50 but total_policies < 8 → RLS is locking you out.
--                       STEP 2 below fixes it.

-- ── STEP 2: (re)create the team policies ─────────────────────────────
-- Safe to run even if the policies already exist.
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

-- ── STEP 3: confirm ──────────────────────────────────────────────────
select tablename, policyname, roles, cmd
from pg_policies
where schemaname = 'public'
order by tablename;
-- Expect 8 rows, each: team_all / {authenticated} / ALL
