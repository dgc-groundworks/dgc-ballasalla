-- DGC Job Planner: wages lockdown, PART B (this is the actual lock)
-- Project: vigdtpcgeqenznuakdwz (Job Planner). Run in Supabase > SQL Editor.
-- 29 Sep 2026. Run only after PART A and after Planner v2.58 is live.
--
-- Removes every old policy on the wage/staff tables (keeping the admin-only
-- one from PART A) and strips the public anon key's access. The one thing
-- anon keeps is what the staff Timesheet app's signup picker needs: the
-- NAMES of staff whose status is Working. No rate, role, dates or ids.
-- The Timesheet app's hours write-through (upsert_dgc_timesheet) is a
-- SECURITY DEFINER function, so it's unaffected.

begin;

do $$
declare p record;
begin
  for p in
    select tablename, policyname from pg_policies
    where schemaname = 'public'
      and tablename in ('dgc_staff', 'dgc_staff_profile', 'dgc_staff_hours',
                        'dgc_staff_advances', 'dgc_staff_leave',
                        'dgc_payroll_approval', 'dgc_timesheets')
      and policyname <> 'dgc_admin_all'
  loop
    execute format('drop policy %I on public.%I', p.policyname, p.tablename);
  end loop;
end $$;

alter table public.dgc_staff            enable row level security;
alter table public.dgc_staff_profile    enable row level security;
alter table public.dgc_staff_hours      enable row level security;
alter table public.dgc_staff_advances   enable row level security;
alter table public.dgc_staff_leave      enable row level security;
alter table public.dgc_payroll_approval enable row level security;
alter table public.dgc_timesheets       enable row level security;

revoke all on public.dgc_staff, public.dgc_staff_profile, public.dgc_staff_hours,
              public.dgc_staff_advances, public.dgc_staff_leave,
              public.dgc_payroll_approval, public.dgc_timesheets
  from anon;

-- Timesheet app signup picker: names of working staff only
grant select (name, status) on public.dgc_staff to anon;
create policy dgc_staff_anon_names on public.dgc_staff
  for select to anon using (status = 'Working');

commit;

-- Check: what policies are left on these tables
select tablename, policyname, roles, cmd
from pg_policies
where schemaname = 'public'
  and tablename in ('dgc_staff', 'dgc_staff_profile', 'dgc_staff_hours',
                    'dgc_staff_advances', 'dgc_staff_leave',
                    'dgc_payroll_approval', 'dgc_timesheets')
order by tablename, policyname;
