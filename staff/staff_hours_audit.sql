-- Staff Hours: record who added or changed every hours entry (Ash, 12 Oct 2026)
-- Additive only: two new columns, one history table, one trigger. No data is changed or removed.

alter table public.dgc_staff_hours add column if not exists created_by text;
alter table public.dgc_staff_hours add column if not exists updated_by text;
alter table public.dgc_staff_hours add column if not exists updated_at timestamptz;

create table if not exists public.dgc_staff_hours_log (
  id bigserial primary key,
  at timestamptz not null default now(),
  action text not null,            -- added / changed / removed
  by_who text not null,            -- the signed-in email, or "Timesheet app (Name)"
  hours_id uuid,
  staff_id uuid,
  work_date date,
  old_hours numeric,
  new_hours numeric,
  old_note text,
  new_note text
);
alter table public.dgc_staff_hours_log enable row level security;
drop policy if exists dgc_admin_read_hours_log on public.dgc_staff_hours_log;
create policy dgc_admin_read_hours_log on public.dgc_staff_hours_log for select
  using (exists (select 1 from public.dgc_app_admins a where lower(a.email) = lower(auth.jwt() ->> 'email')));

create or replace function public.dgc_staff_hours_who() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  who text := nullif(auth.jwt() ->> 'email', '');
  sname text;
  sid uuid := coalesce(new.staff_id, old.staff_id);
begin
  if who is null then
    select name into sname from public.dgc_staff where id = sid;
    who := 'Timesheet app (' || coalesce(sname, 'unknown staff') || ')';
  end if;
  if tg_op = 'INSERT' then
    new.created_by := coalesce(new.created_by, who);
    new.updated_by := who; new.updated_at := now();
    insert into public.dgc_staff_hours_log(action, by_who, hours_id, staff_id, work_date, new_hours, new_note)
      values ('added', who, new.id, new.staff_id, new.work_date, new.hours, new.note);
    return new;
  elsif tg_op = 'UPDATE' then
    if new.hours is distinct from old.hours or new.note is distinct from old.note then
      new.updated_by := who; new.updated_at := now();
      insert into public.dgc_staff_hours_log(action, by_who, hours_id, staff_id, work_date, old_hours, new_hours, old_note, new_note)
        values ('changed', who, new.id, new.staff_id, new.work_date, old.hours, new.hours, old.note, new.note);
    end if;
    return new;
  else
    insert into public.dgc_staff_hours_log(action, by_who, hours_id, staff_id, work_date, old_hours, old_note)
      values ('removed', who, old.id, old.staff_id, old.work_date, old.hours, old.note);
    return old;
  end if;
end $$;

drop trigger if exists dgc_staff_hours_who_ins_upd on public.dgc_staff_hours;
create trigger dgc_staff_hours_who_ins_upd before insert or update on public.dgc_staff_hours
  for each row execute function public.dgc_staff_hours_who();
drop trigger if exists dgc_staff_hours_who_del on public.dgc_staff_hours;
create trigger dgc_staff_hours_who_del after delete on public.dgc_staff_hours
  for each row execute function public.dgc_staff_hours_who();
