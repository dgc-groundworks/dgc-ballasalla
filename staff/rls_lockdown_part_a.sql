-- DGC Job Planner: wages lockdown, PART A (safe, changes nothing that's live yet)
-- Project: vigdtpcgeqenznuakdwz (Job Planner). Run in Supabase > SQL Editor.
-- 29 Sep 2026.
--
-- Creates an admin allowlist and adds admin-only policies alongside the
-- existing ones. The current anon access keeps working until PART B runs.
-- Signups are open on this project, so "logged in" is not enough on its own:
-- access is keyed to the allowlist, not to any authenticated user.

-- 1. Admin allowlist (nobody can read or change it through the API)
create table if not exists public.dgc_app_admins (
  email    text primary key,
  added_at timestamptz default now()
);
alter table public.dgc_app_admins enable row level security;
revoke all on public.dgc_app_admins from anon, authenticated;

-- 2. "Is the signed-in user on the allowlist?"
create or replace function public.is_dgc_admin()
returns boolean
language sql stable security definer
set search_path = public
as $$
  select exists (
    select 1 from public.dgc_app_admins a
    where a.email = lower(coalesce(auth.jwt() ->> 'email', ''))
  );
$$;
revoke all on function public.is_dgc_admin() from public;
grant execute on function public.is_dgc_admin() to anon, authenticated;

-- 3. Seed the allowlist with every existing confirmed login on this project
insert into public.dgc_app_admins (email)
select lower(email) from auth.users
where email is not null and email_confirmed_at is not null
on conflict do nothing;

-- 4. Admin-only policy on every table that holds wages, hours or staff records
--    (plus dgc_planner_jobs, which the Planner will now read while logged in)
do $$
declare t text;
begin
  foreach t in array array[
    'dgc_staff', 'dgc_staff_profile', 'dgc_staff_hours', 'dgc_staff_advances',
    'dgc_staff_leave', 'dgc_payroll_approval', 'dgc_timesheets', 'dgc_planner_jobs'
  ] loop
    execute format('drop policy if exists dgc_admin_all on public.%I', t);
    execute format('create policy dgc_admin_all on public.%I for all to authenticated
                    using (public.is_dgc_admin()) with check (public.is_dgc_admin())', t);
    execute format('grant select, insert, update, delete on public.%I to authenticated', t);
  end loop;
end $$;

-- 5. Show who is now on the allowlist. Check every email is someone you know.
select a.email, u.created_at, u.last_sign_in_at
from public.dgc_app_admins a
left join auth.users u on lower(u.email) = a.email
order by u.last_sign_in_at desc nulls last;
