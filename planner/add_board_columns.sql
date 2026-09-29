-- Job Planner: Trello-style columns under the timeline (29 Sep 2026, v2.72).
-- Run once in Supabase > SQL Editor (project vigdtpcgeqenznuakdwz). Safe to re-run.
--
-- dgc_planner_board holds the columns (title, colour, order). The five status
-- columns are linked to a job status (dropping a job there changes its status);
-- columns people add themselves have status = null and just group jobs.
-- Each job remembers its own column (board_col) and place in it (board_pos).

alter table public.dgc_planner_jobs
  add column if not exists board_col text,
  add column if not exists board_pos double precision;

create table if not exists public.dgc_planner_board (
  id         text primary key,
  title      text not null,
  status     text,
  color      text,
  pos        double precision not null default 0,
  updated_at timestamptz not null default now()
);

alter table public.dgc_planner_board enable row level security;
drop policy if exists dgc_planner_board_admin on public.dgc_planner_board;
create policy dgc_planner_board_admin on public.dgc_planner_board
  for all to authenticated using (public.is_dgc_admin()) with check (public.is_dgc_admin());

insert into public.dgc_planner_board (id, title, status, pos) values
  ('running',          'Running',          'running',          1),
  ('awarded',          'Awarded',          'awarded',          2),
  ('tendering_likely', 'Probably Awarded', 'tendering_likely', 3),
  ('placeholder',      'Other',            'placeholder',      4),
  ('tendering',        'Pricing',          'tendering',        5)
on conflict (id) do nothing;

do $$ begin
  alter publication supabase_realtime add table public.dgc_planner_board;
exception when duplicate_object then null; end $$;

select id, title, status, pos from public.dgc_planner_board order by pos;
