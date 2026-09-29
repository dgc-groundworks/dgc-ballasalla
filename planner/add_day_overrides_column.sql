-- Job Planner: store day/range headcount overrides with the job so everyone sees them (29 Sep 2026). Run in Supabase SQL editor (already run 29 Sep 2026).
alter table public.dgc_planner_jobs add column if not exists day_overrides jsonb not null default '[]'::jsonb;
