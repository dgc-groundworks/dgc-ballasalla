-- DGC Accident Reports (Job Planner, 7 Oct 2026)
-- Run once in the Supabase SQL Editor for the Job Planner project.
-- Fields match Harry's DGC OS Site App accident form line by line, so both apps hold the same data.

CREATE TABLE IF NOT EXISTS public.dgc_accidents (
  id            uuid        DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at    timestamptz DEFAULT now(),
  source        text        NOT NULL DEFAULT 'planner',   -- planner | dgcos
  external_id   text        UNIQUE,                       -- DGC OS site_records id, for tablet reports
  job           text        NOT NULL,                     -- job name as in the Planner
  gang          text,
  accident_at   timestamptz NOT NULL,                     -- "Date & Time of Accident"
  injured       text        NOT NULL,                     -- "Name of Injured Person"
  location      text,                                     -- "Location on Site"
  injury        text,                                     -- "Nature of Injury"
  what          text,                                     -- "What happened?"
  action        text,                                     -- "Immediate action taken"
  witnesses     text,                                     -- "Witnesses"
  photos        jsonb       NOT NULL DEFAULT '[]',        -- compressed photo data
  reported_by   text,                                     -- "Reported by"
  signature     text,                                     -- signature image
  filed_at      timestamptz                               -- set once copied into the job folders
);

ALTER TABLE public.dgc_accidents ENABLE ROW LEVEL SECURITY;

-- Only Planner admins (the dgc_app_admins allowlist) can read or write. Signups are open on this project.
DROP POLICY IF EXISTS "Accidents: admin all" ON public.dgc_accidents;
CREATE POLICY "Accidents: admin all" ON public.dgc_accidents FOR ALL TO authenticated
  USING (public.is_dgc_admin()) WITH CHECK (public.is_dgc_admin());

-- The filing task on Ash's Mac uses a private key (kept in the Directors Vault logins file) instead of a login.
CREATE OR REPLACE FUNCTION public.dgc_accident_key_ok(p_key text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, extensions AS $$
  SELECT encode(extensions.digest(coalesce(p_key, ''), 'sha256'), 'hex') = 'beeb1f5add5cc59c72c7225ea4fc065f8ebc9c41056ef2956fa6fa3d5da3e90a';
$$;
REVOKE ALL ON FUNCTION public.dgc_accident_key_ok(text) FROM public;

-- Accidents not yet filed into the job folders
CREATE OR REPLACE FUNCTION public.dgc_accidents_to_file(p_key text)
RETURNS SETOF public.dgc_accidents
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.dgc_accident_key_ok(p_key) THEN RAISE EXCEPTION 'not allowed'; END IF;
  RETURN QUERY SELECT * FROM public.dgc_accidents WHERE filed_at IS NULL ORDER BY accident_at;
END $$;

-- Mark one accident as filed
CREATE OR REPLACE FUNCTION public.dgc_accident_mark_filed(p_key text, p_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.dgc_accident_key_ok(p_key) THEN RAISE EXCEPTION 'not allowed'; END IF;
  UPDATE public.dgc_accidents SET filed_at = now() WHERE id = p_id;
END $$;

-- Add an accident reported on a DGC OS tablet (once Harry's side is connected). Same fields, no duplicates.
CREATE OR REPLACE FUNCTION public.dgc_accident_add_external(p_key text, p_external_id text, p_job text, p_gang text,
  p_accident_at timestamptz, p_injured text, p_location text, p_injury text, p_what text, p_action text,
  p_witnesses text, p_photos jsonb, p_reported_by text, p_signature text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.dgc_accident_key_ok(p_key) THEN RAISE EXCEPTION 'not allowed'; END IF;
  INSERT INTO public.dgc_accidents (source, external_id, job, gang, accident_at, injured, location, injury, what, action, witnesses, photos, reported_by, signature)
  VALUES ('dgcos', p_external_id, p_job, p_gang, p_accident_at, p_injured, p_location, p_injury, p_what, p_action, p_witnesses, coalesce(p_photos, '[]'), p_reported_by, p_signature)
  ON CONFLICT (external_id) DO NOTHING;
END $$;

GRANT EXECUTE ON FUNCTION public.dgc_accidents_to_file(text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.dgc_accident_mark_filed(text, uuid) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.dgc_accident_add_external(text, text, text, text, timestamptz, text, text, text, text, text, text, jsonb, text, text) TO anon, authenticated;

SELECT 'dgc_accidents ready' AS status, count(*) FROM public.dgc_accidents;
