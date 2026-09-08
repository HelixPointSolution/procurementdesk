-- Supplier quotation attachments on the Compare tab (phase 1: store + view).
-- Additive only. Safe on a live database. Run with Ctrl+A in the SQL editor.

create table if not exists quote_attachments (
  id          uuid primary key default gen_random_uuid(),
  quote_id    uuid not null references quotes(id) on delete cascade,
  path        text not null,            -- object path inside the bucket
  filename    text not null,
  mime        text not null default '',
  size        int  not null default 0,
  uploaded_by text not null default '',
  uploaded_at timestamptz not null default now()
);
create index if not exists quote_attachments_quote_id_idx on quote_attachments (quote_id);

alter table quote_attachments enable row level security;
drop policy if exists team_all on quote_attachments;
create policy team_all on quote_attachments
  for all to authenticated using (true) with check (true);

-- Private bucket for the files themselves.
insert into storage.buckets (id, name, public)
values ('quotation-files', 'quotation-files', false)
on conflict (id) do nothing;

drop policy if exists "team read quotation-files"   on storage.objects;
drop policy if exists "team upload quotation-files" on storage.objects;
drop policy if exists "team delete quotation-files" on storage.objects;

create policy "team read quotation-files" on storage.objects
  for select to authenticated using (bucket_id = 'quotation-files');
create policy "team upload quotation-files" on storage.objects
  for insert to authenticated with check (bucket_id = 'quotation-files');
create policy "team delete quotation-files" on storage.objects
  for delete to authenticated using (bucket_id = 'quotation-files');

-- Proof of migration
select
  (select count(*) from information_schema.tables where table_name = 'quote_attachments') as attachments_table, -- expect 1
  (select count(*) from storage.buckets where id = 'quotation-files') as bucket;                                   -- expect 1
