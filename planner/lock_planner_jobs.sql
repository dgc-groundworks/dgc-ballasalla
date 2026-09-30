-- Job Planner: lock the jobs table (30 Sep 2026). Project vigdtpcgeqenznuakdwz.
--
-- Before: policy "open_anon" let anyone holding the public web key (it's in
-- the page source) add, change or delete jobs without logging in, and
-- "all_auth" let ANY logged-in account do the same, not just Planner admins.
-- After: only people on the Planner list (dgc_app_admins, is_dgc_admin())
-- can read or change jobs. The staff Timesheet app (dgc-ltd.github.io) keeps
-- reading job NAMES for its site picker, and nothing else.

begin;

drop policy if exists open_anon on public.dgc_planner_jobs;
drop policy if exists all_auth  on public.dgc_planner_jobs;
-- dgc_admin_all (authenticated, is_dgc_admin()) stays as it is

revoke all on public.dgc_planner_jobs from anon;
grant select (name, archived) on public.dgc_planner_jobs to anon;
drop policy if exists anon_job_names on public.dgc_planner_jobs;
create policy anon_job_names on public.dgc_planner_jobs for select to anon using (true);

commit;

select policyname, cmd, array_to_string(roles, ',') as roles, qual
from pg_policies where schemaname = 'public' and tablename = 'dgc_planner_jobs'
order by policyname;

-- To undo (only if something breaks):
-- create policy open_anon on public.dgc_planner_jobs for all to anon using (true) with check (true);
-- create policy all_auth  on public.dgc_planner_jobs for all to authenticated using (true) with check (true);
-- grant all on public.dgc_planner_jobs to anon;
