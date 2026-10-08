-- DGC data share: lets Harry's DGC OS read the Job Planner's staff, vehicles, jobs and accidents,
-- and add tablet accidents to the one accident register (Ash, 8 Oct 2026).
-- Protected by its own key (only its hash is here). The key is in Directors Vault/_Logins/Logins & Keys.md.
-- Pay rates, card numbers, NI and bank details are never shared.

CREATE OR REPLACE FUNCTION public.dgc_share_key_ok(p_key text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, extensions AS $$
  SELECT encode(extensions.digest(coalesce(p_key, ''), 'sha256'), 'hex') = '06dd3e1ab56b9fdc66fb69941bf6030ce523cc5c7d208a24bc327c5da1238e7e';
$$;
REVOKE ALL ON FUNCTION public.dgc_share_key_ok(text) FROM public;

-- Staff: the current staff list (Ash's Job Planner is the master). No pay.
CREATE OR REPLACE FUNCTION public.dgc_share_staff(p_key text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.dgc_share_key_ok(p_key) THEN RAISE EXCEPTION 'not allowed'; END IF;
  RETURN (SELECT coalesce(jsonb_agg(jsonb_build_object(
      'id', j->'id', 'name', j->'name', 'role', j->'role', 'active', j->'active', 'status', j->'status',
      'off_work_type', j->'off_work_type', 'start_date', j->'start_date', 'skills', j->'skills') ORDER BY j->>'name'), '[]'::jsonb)
    FROM (SELECT to_jsonb(s) AS j FROM public.dgc_staff s) x);
END $$;

-- Vehicles: no fuel card numbers.
CREATE OR REPLACE FUNCTION public.dgc_share_vehicles(p_key text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.dgc_share_key_ok(p_key) THEN RAISE EXCEPTION 'not allowed'; END IF;
  RETURN (SELECT coalesce(jsonb_agg(jsonb_build_object(
      'id', j->'id', 'nickname', j->'nickname', 'registration', j->'registration',
      'current_driver', j->'current_driver', 'status', j->'status') ORDER BY j->>'nickname'), '[]'::jsonb)
    FROM (SELECT to_jsonb(v) AS j FROM public.dgc_vehicles v) x);
END $$;

-- Jobs: the Planner's job list and timeline.
CREATE OR REPLACE FUNCTION public.dgc_share_jobs(p_key text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.dgc_share_key_ok(p_key) THEN RAISE EXCEPTION 'not allowed'; END IF;
  RETURN (SELECT coalesce(jsonb_agg(jsonb_build_object(
      'id', j->'id', 'name', j->'name', 'status', j->'status', 'start_date', j->'start_date',
      'base_days', j->'base_days', 'day_overrides', j->'day_overrides', 'archived', j->'archived',
      'board_col', j->'board_col', 'updated_at', j->'updated_at') ORDER BY j->>'start_date'), '[]'::jsonb)
    FROM (SELECT to_jsonb(p) AS j FROM public.dgc_planner_jobs p) x);
END $$;

-- Accidents: the one register (Planner and tablet). p_since = only those created after this time (null = all).
CREATE OR REPLACE FUNCTION public.dgc_share_accidents(p_key text, p_since timestamptz DEFAULT NULL) RETURNS SETOF public.dgc_accidents
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.dgc_share_key_ok(p_key) THEN RAISE EXCEPTION 'not allowed'; END IF;
  RETURN QUERY SELECT * FROM public.dgc_accidents WHERE p_since IS NULL OR created_at > p_since ORDER BY accident_at DESC;
END $$;

-- Tablet accident in: call this the moment the Site App saves an accident. No duplicates (keyed on the DGC OS record id).
CREATE OR REPLACE FUNCTION public.dgc_share_add_accident(p_key text, p_external_id text, p_job text, p_gang text,
  p_accident_at timestamptz, p_injured text, p_location text, p_injury text, p_what text, p_action text,
  p_witnesses text, p_photos jsonb, p_reported_by text, p_signature text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.dgc_share_key_ok(p_key) THEN RAISE EXCEPTION 'not allowed'; END IF;
  INSERT INTO public.dgc_accidents (source, external_id, job, gang, accident_at, injured, location, injury, what, action, witnesses, photos, reported_by, signature)
  VALUES ('dgcos', p_external_id, p_job, p_gang, p_accident_at, p_injured, p_location, p_injury, p_what, p_action, p_witnesses, coalesce(p_photos, '[]'), p_reported_by, p_signature)
  ON CONFLICT (external_id) DO NOTHING;
END $$;

GRANT EXECUTE ON FUNCTION public.dgc_share_staff(text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.dgc_share_vehicles(text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.dgc_share_jobs(text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.dgc_share_accidents(text, timestamptz) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.dgc_share_add_accident(text, text, text, text, timestamptz, text, text, text, text, text, text, jsonb, text, text) TO anon, authenticated;

-- ── Resource allocation (who is on which job each week) moves from the browser into the database ──
-- Same shape the Planner always used: { "<job id>": { "<week start YYYY-MM-DD>": ["Name", ...], "pm": ["Name"] } }
CREATE TABLE IF NOT EXISTS public.dgc_resource_alloc (
  id          text        PRIMARY KEY DEFAULT 'main',
  data        jsonb       NOT NULL DEFAULT '{}',
  updated_at  timestamptz DEFAULT now(),
  updated_by  text
);
ALTER TABLE public.dgc_resource_alloc ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Resource alloc: admin all" ON public.dgc_resource_alloc;
CREATE POLICY "Resource alloc: admin all" ON public.dgc_resource_alloc FOR ALL TO authenticated
  USING (public.is_dgc_admin()) WITH CHECK (public.is_dgc_admin());
INSERT INTO public.dgc_resource_alloc (id) VALUES ('main') ON CONFLICT (id) DO NOTHING;
DO $$ BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.dgc_resource_alloc;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Allocation for DGC OS: one row per job and week (kind 'crew'), plus the job's PM (kind 'pm', no week).
CREATE OR REPLACE FUNCTION public.dgc_share_allocation(p_key text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.dgc_share_key_ok(p_key) THEN RAISE EXCEPTION 'not allowed'; END IF;
  RETURN (SELECT coalesce(jsonb_agg(jsonb_build_object(
      'job_id', j.key, 'job_name', (SELECT p.name FROM public.dgc_planner_jobs p WHERE p.id::text = j.key),
      'kind', CASE WHEN w.key = 'pm' THEN 'pm' ELSE 'crew' END,
      'week_start', CASE WHEN w.key = 'pm' THEN NULL ELSE w.key END,
      'staff', w.value) ORDER BY j.key, w.key), '[]'::jsonb)
    FROM public.dgc_resource_alloc a,
         jsonb_each(a.data) j,
         jsonb_each(CASE WHEN jsonb_typeof(j.value) = 'object' THEN j.value ELSE '{}'::jsonb END) w
    WHERE a.id = 'main');
END $$;
GRANT EXECUTE ON FUNCTION public.dgc_share_allocation(text) TO anon, authenticated;

SELECT 'data share ready' AS status;
