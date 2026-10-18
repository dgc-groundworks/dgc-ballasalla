-- Staff app 1B (18 Oct 2026). Additive only. Project: vigdtpcgeqenznuakdwz (Job Planner).
-- 1. Contract and probation facts on the existing profile row.
alter table public.dgc_staff_profile
  add column if not exists contract_status text,        -- Signed, Sent, Draft or None
  add column if not exists contract_signed_on date,
  add column if not exists probation_end date,          -- set when the written outcome is known; blank = six months from start
  add column if not exists probation_note text;

-- 2. One row per document: contract, starter form, ticket, certificate, ID, work permit, review, other.
create table if not exists public.dgc_staff_docs (
  id uuid primary key default gen_random_uuid(),
  staff_id uuid not null references public.dgc_staff(id) on delete cascade,
  kind text not null default 'Other',
  title text,
  issued_on date,
  expires_on date,
  file_path text,                 -- path inside the private bucket staff-media
  notes text,
  hr_copied_on timestamptz,       -- stamped by the daily copy to the HR folders
  removed_on timestamptz,         -- hidden, never deleted
  created_at timestamptz not null default now(),
  created_by text default (auth.jwt() ->> 'email')
);
create index if not exists dgc_staff_docs_staff on public.dgc_staff_docs (staff_id);
alter table public.dgc_staff_docs enable row level security;
drop policy if exists dgc_admin_all on public.dgc_staff_docs;
create policy dgc_admin_all on public.dgc_staff_docs for all to authenticated
  using (public.is_dgc_admin()) with check (public.is_dgc_admin());
grant select, insert, update on public.dgc_staff_docs to authenticated;

-- 3. The staff-media bucket held bank, ID and certificate images behind "any signed-in user" rules,
--    and sign-ups on this project are open. Limit it to the same people as the wages (is_dgc_admin).
--    (0 files in the bucket on 18 Oct 2026, so nothing breaks.)
drop policy if exists "Staff media: authenticated upload" on storage.objects;
drop policy if exists "Staff media: authenticated read" on storage.objects;
drop policy if exists "Staff media: authenticated delete" on storage.objects;
drop policy if exists "Staff media: admins upload" on storage.objects;
drop policy if exists "Staff media: admins read" on storage.objects;
create policy "Staff media: admins upload" on storage.objects for insert to authenticated
  with check (bucket_id = 'staff-media' and public.is_dgc_admin());
create policy "Staff media: admins read" on storage.objects for select to authenticated
  using (bucket_id = 'staff-media' and public.is_dgc_admin());
-- no delete policy on purpose: files are kept.
