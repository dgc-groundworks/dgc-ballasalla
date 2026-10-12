-- Pay-run history (Ash, 12 Oct 2026): unapproving a week must not wipe out the fact that it was
-- already paid. Every approve and unapprove is logged; "Wages brought forward" uses the FIRST time a
-- week was approved (when its pay went to the accountants). Additive only.
create table if not exists public.dgc_payroll_approval_log (
  id bigserial primary key,
  period_start date not null,
  action text not null,               -- approved / unapproved
  by_who text,
  approved_at timestamptz,            -- the approval time, for "approved" rows
  at timestamptz not null default now()
);
alter table public.dgc_payroll_approval_log enable row level security;
drop policy if exists dgc_admin_read_approval_log on public.dgc_payroll_approval_log;
create policy dgc_admin_read_approval_log on public.dgc_payroll_approval_log for select
  using (exists (select 1 from public.dgc_app_admins a where lower(a.email) = lower(auth.jwt() ->> 'email')));

create or replace function public.dgc_payroll_approval_logger() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    insert into public.dgc_payroll_approval_log(period_start, action, by_who, approved_at)
      values (new.period_start, 'approved', coalesce(new.approved_by, auth.jwt() ->> 'email'), coalesce(new.approved_at, now()));
  else
    insert into public.dgc_payroll_approval_log(period_start, action, by_who)
      values (old.period_start, 'unapproved', coalesce(auth.jwt() ->> 'email', 'unknown'));
  end if;
  return null;
end $$;
drop trigger if exists dgc_payroll_approval_log_trg on public.dgc_payroll_approval;
create trigger dgc_payroll_approval_log_trg after insert or delete on public.dgc_payroll_approval
  for each row execute function public.dgc_payroll_approval_logger();

-- Seed: every week that is approved right now, plus w/c 28 Sep 2026 (approved by Harry on
-- 4 Oct at 21:21 BST, unapproved by Ash on 12 Oct before this log existed).
insert into public.dgc_payroll_approval_log(period_start, action, by_who, approved_at, at)
  select a.period_start, 'approved', a.approved_by, a.approved_at, a.approved_at from public.dgc_payroll_approval a
  where not exists (select 1 from public.dgc_payroll_approval_log l where l.period_start = a.period_start and l.action = 'approved');
insert into public.dgc_payroll_approval_log(period_start, action, by_who, approved_at, at)
  select '2026-09-28', 'approved', 'harry@dgc.im', '2026-10-04T20:21:37.463+00:00', '2026-10-04T20:21:37.463+00:00'
  where not exists (select 1 from public.dgc_payroll_approval_log l where l.period_start = '2026-09-28' and l.action = 'approved');
