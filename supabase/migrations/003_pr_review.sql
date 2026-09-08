-- Purchase Requisition -> PR Review (client spec, 3 Sep 2026).
-- Additive only. Safe on a live database. Run with Ctrl+A in the SQL editor.
--
-- Each RFQ now carries two sets of items: the requester's original Purchase
-- Requisition (stage = 'pr') and the reviewer's editable copy (stage = 'review').
-- Emails and the Compare tab read ONLY the review copy.
--
-- Defaults are 'review' so every RFQ that already exists keeps working exactly
-- as before: its items are treated as already reviewed.

alter table rfq_items
  add column if not exists stage text not null default 'review'
  check (stage in ('pr', 'review'));

alter table rfqs
  add column if not exists stage text not null default 'review'
  check (stage in ('pr', 'review'));

alter table rfqs
  add column if not exists sent_to_review_at timestamptz;

create index if not exists rfq_items_rfq_id_stage_idx on rfq_items (rfq_id, stage);

-- Proof of migration
select
  (select count(*) from information_schema.columns
     where table_name = 'rfq_items' and column_name = 'stage') as rfq_items_stage,   -- expect 1
  (select count(*) from information_schema.columns
     where table_name = 'rfqs' and column_name = 'sent_to_review_at') as rfqs_sent;  -- expect 1
