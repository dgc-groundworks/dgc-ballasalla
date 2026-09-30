-- Job Planner: notifications bell (30 Sep 2026, v2.87). Project vigdtpcgeqenznuakdwz.
-- Run once in Supabase > SQL Editor. Safe to re-run. Adds things only.
--
-- 1. base_days: the extra days on top of whole weeks were saved in each
--    person's own browser, so nobody else saw them. Now saved on the job.
-- 2. dgc_planner_activity: one line per person, per job (or column), per day,
--    holding where it started the day (before) and where it is now (after).
--    Written by database triggers, so it records who really made the change
--    (their login) and catches every change from any page. Nobody can write
--    to it directly. Planner admins can read it. Kept for 8 days.

alter table public.dgc_planner_jobs add column if not exists base_days int;

create table if not exists public.dgc_planner_activity (
  id        bigserial primary key,
  day       date not null,
  actor     text not null,
  kind      text not null,            -- 'job' or 'column'
  item_id   text not null,
  item_name text,
  before    jsonb,                    -- null = it was added today
  after     jsonb,                    -- null = it was deleted
  first_at  timestamptz not null default now(),
  last_at   timestamptz not null default now(),
  unique (day, actor, kind, item_id)
);
create index if not exists dgc_planner_activity_last on public.dgc_planner_activity (last_at desc);

alter table public.dgc_planner_activity enable row level security;
drop policy if exists dgc_planner_activity_read on public.dgc_planner_activity;
create policy dgc_planner_activity_read on public.dgc_planner_activity
  for select to authenticated using (public.is_dgc_admin());
revoke insert, update, delete, truncate on public.dgc_planner_activity from anon, authenticated;

create or replace function public.dgc_log_activity(p_kind text, p_id text, p_name text, p_old jsonb, p_new jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_actor text := coalesce(nullif(auth.jwt() ->> 'email', ''), 'someone');
  v_day   date := (now() at time zone 'Europe/Isle_of_Man')::date;
begin
  if p_old is not distinct from p_new then return; end if;
  insert into dgc_planner_activity (day, actor, kind, item_id, item_name, before, after)
  values (v_day, v_actor, p_kind, p_id, p_name, p_old, p_new)
  on conflict (day, actor, kind, item_id)
  do update set after = excluded.after, item_name = excluded.item_name, last_at = now();
  delete from dgc_planner_activity where day < v_day - 8;
end $$;

create or replace function public.dgc_job_snap(j public.dgc_planner_jobs) returns jsonb
language sql immutable as $$
  select jsonb_build_object(
    'name', j.name, 'start_date', j.start_date, 'base_weeks', j.base_weeks, 'base_days', j.base_days,
    'people_needed', j.people_needed, 'people_on_site', j.people_on_site, 'status', j.status,
    'archived', j.archived, 'on_timeline', j.on_timeline, 'note', j.note,
    'board_col', j.board_col, 'day_overrides', j.day_overrides)
$$;

create or replace function public.dgc_jobs_activity_trg() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    perform dgc_log_activity('job', new.id::text, new.name, null, dgc_job_snap(new));
  elsif tg_op = 'UPDATE' then
    if dgc_job_snap(old) is distinct from dgc_job_snap(new) then
      perform dgc_log_activity('job', new.id::text, new.name, dgc_job_snap(old), dgc_job_snap(new));
    end if;
  else
    perform dgc_log_activity('job', old.id::text, old.name, dgc_job_snap(old), null);
  end if;
  return null;
end $$;
drop trigger if exists dgc_jobs_activity on public.dgc_planner_jobs;
create trigger dgc_jobs_activity after insert or update or delete on public.dgc_planner_jobs
  for each row execute function public.dgc_jobs_activity_trg();

create or replace function public.dgc_board_activity_trg() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  o jsonb := case when tg_op <> 'INSERT' then jsonb_build_object('title', old.title, 'color', old.color, 'pos', old.pos, 'status', old.status) end;
  n jsonb := case when tg_op <> 'DELETE' then jsonb_build_object('title', new.title, 'color', new.color, 'pos', new.pos, 'status', new.status) end;
begin
  if o is distinct from n then
    perform dgc_log_activity('column', coalesce(new.id, old.id), coalesce(new.title, old.title), o, n);
  end if;
  return null;
end $$;
drop trigger if exists dgc_board_activity on public.dgc_planner_board;
create trigger dgc_board_activity after insert or update or delete on public.dgc_planner_board
  for each row execute function public.dgc_board_activity_trg();

do $$ begin
  alter publication supabase_realtime add table public.dgc_planner_activity;
exception when duplicate_object then null; end $$;

select 'ready' as status,
  (select count(*) from information_schema.columns where table_name = 'dgc_planner_jobs' and column_name = 'base_days') as base_days_column,
  (select count(*) from pg_trigger where tgname in ('dgc_jobs_activity', 'dgc_board_activity')) as triggers;
