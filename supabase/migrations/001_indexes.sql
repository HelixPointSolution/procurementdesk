-- Additive only — safe to run on a live database, deletes nothing.
-- Run in Supabase → SQL Editor after schema.sql.

-- quote_items.rfq_item_id is an unindexed FK with ON DELETE CASCADE, so every
-- rfq_items delete forced a sequential scan of quote_items.
create index if not exists quote_items_rfq_item_id_idx
  on quote_items (rfq_item_id);

-- history/page.tsx orders the whole table by date desc.
create index if not exists purchase_history_date_idx
  on purchase_history (date desc);
create index if not exists purchase_history_rfq_id_idx
  on purchase_history (rfq_id);

-- The main list query in both RfqEditor and CompareEditor:
--   where kind = ? order by created_at desc
create index if not exists rfqs_kind_created_at_idx
  on rfqs (kind, created_at desc);
