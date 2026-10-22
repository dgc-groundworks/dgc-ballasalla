-- hub-planner-login (22 Oct 2026): the database part of the Silverdale app's "Make a login" for the Job Planner.
-- Ash, 22 Oct 2026: "she needs an account for the Job Planner ... Make an account for the Job Planner."
-- Additive only: three new functions, callable by the service role only (the hub-planner-login Edge Function).
-- Nothing existing is changed: not os-session-exchange, not dgc_os_exchange_check, not invite-staff, not dgc_app_admins.

-- who has a Job Planner login, matched exactly as public.dgc_os_exchange_check matches (lower(email), not SSO)
create or replace function public.hub_planner_login_state(p_emails text[])
returns jsonb language sql stable security definer set search_path to 'public', 'auth' as $$
  select coalesce(jsonb_agg(jsonb_build_object(
      'email', q.e,
      'id', u.id,
      'login', u.id is not null and u.deleted_at is null and not coalesce(u.is_anonymous, false),
      'confirmed', u.email_confirmed_at is not null,
      'off', u.banned_until is not null and u.banned_until > now(),
      'allow', exists (select 1 from public.dgc_app_admins a where lower(a.email) = q.e),
      'lastSignIn', u.last_sign_in_at) order by q.e), '[]'::jsonb)
  from (select distinct lower(trim(x)) as e from unnest(coalesce(p_emails, '{}'::text[])) x where coalesce(trim(x), '') <> '') q
  left join lateral (select * from auth.users w where lower(w.email) = q.e and coalesce(w.is_sso_user, false) = false
                     order by w.created_at limit 1) u on true;
$$;

-- the Planner allow-list (what invite-staff does): add the email if it is not there; never removes anyone
create or replace function public.hub_planner_allow(p_email text)
returns boolean language plpgsql volatile security definer set search_path to 'public' as $$
declare n integer;
begin
  insert into public.dgc_app_admins (email) values (lower(trim(p_email))) on conflict (email) do nothing;
  get diagnostics n = row_count;
  return n > 0;
end $$;

-- end every session of one Planner login (switch off): it can't be refreshed after this
create or replace function public.hub_planner_end_sessions(p_user uuid)
returns integer language plpgsql volatile security definer set search_path to 'public', 'auth' as $$
declare n integer;
begin
  delete from auth.sessions where user_id = p_user;
  get diagnostics n = row_count;
  return n;
end $$;

do $$
declare f text;
begin
  foreach f in array array['public.hub_planner_login_state(text[])', 'public.hub_planner_allow(text)', 'public.hub_planner_end_sessions(uuid)'] loop
    execute 'revoke all on function ' || f || ' from public';
    execute 'revoke all on function ' || f || ' from anon';
    execute 'revoke all on function ' || f || ' from authenticated';
    execute 'grant execute on function ' || f || ' to service_role';
  end loop;
end $$;
