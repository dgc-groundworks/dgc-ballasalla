-- DGC Toolbox Talks (Job Planner, 20 Oct 2026)
-- Ash: "as well as an accident report... one that is a toolbox talk... saved in Peel Breakwater toolbox talks, just like the risk tickets."
-- Run once in the Supabase SQL Editor for the Job Planner project (vigdtpcgeqenznuakdwz).
-- Same pattern as dgc_accidents: Planner list only (is_dgc_admin), filed hourly from Ash's Mac with the same private key.
-- Fields follow CITB good practice (GE700 GA11 attendance record) plus the tablet app's toolbox talk (topic, points, attendees).

CREATE TABLE IF NOT EXISTS public.dgc_toolbox_talks (
  id            uuid        DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at    timestamptz DEFAULT now(),
  updated_at    timestamptz DEFAULT now(),
  source        text        NOT NULL DEFAULT 'planner',   -- planner | dgcos
  external_id   text        UNIQUE,                       -- DGC OS site_records id, for tablet talks (later, Harry's yes)
  job           text        NOT NULL,
  talk_at       timestamptz NOT NULL,
  duration_min  integer,
  topic         text        NOT NULL,
  rams_ref      text,
  points        text,                                     -- key points and hazards
  on_this_job   text,                                     -- what it means on this job
  questions     text,
  actions       text,
  presenter     text,
  presenter_sig text,                                     -- signature image
  attendees     jsonb       NOT NULL DEFAULT '[]',        -- [{name, company, sig, time}]
  manager       text,
  manager_sig   text,
  created_by    text,
  filed_at      timestamptz
);

ALTER TABLE public.dgc_toolbox_talks ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Toolbox: admin all" ON public.dgc_toolbox_talks;
CREATE POLICY "Toolbox: admin all" ON public.dgc_toolbox_talks FOR ALL TO authenticated
  USING (public.is_dgc_admin()) WITH CHECK (public.is_dgc_admin());

-- An edit after filing means the PDF is filed again (same file, replaced)
CREATE OR REPLACE FUNCTION public.dgc_toolbox_touch() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.filed_at IS DISTINCT FROM OLD.filed_at
     AND (to_jsonb(NEW) - 'filed_at' - 'updated_at') = (to_jsonb(OLD) - 'filed_at' - 'updated_at') THEN
    RETURN NEW;  -- only the filing stamp changed
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS dgc_toolbox_touch ON public.dgc_toolbox_talks;
CREATE TRIGGER dgc_toolbox_touch BEFORE UPDATE ON public.dgc_toolbox_talks
  FOR EACH ROW EXECUTE FUNCTION public.dgc_toolbox_touch();

CREATE OR REPLACE FUNCTION public.dgc_toolbox_to_file(p_key text)
RETURNS SETOF public.dgc_toolbox_talks
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.dgc_accident_key_ok(p_key) THEN RAISE EXCEPTION 'not allowed'; END IF;
  RETURN QUERY SELECT * FROM public.dgc_toolbox_talks
    WHERE filed_at IS NULL OR updated_at > filed_at ORDER BY talk_at;
END $$;

CREATE OR REPLACE FUNCTION public.dgc_toolbox_mark_filed(p_key text, p_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.dgc_accident_key_ok(p_key) THEN RAISE EXCEPTION 'not allowed'; END IF;
  UPDATE public.dgc_toolbox_talks SET filed_at = now() WHERE id = p_id;
END $$;

GRANT EXECUTE ON FUNCTION public.dgc_toolbox_to_file(text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.dgc_toolbox_mark_filed(text, uuid) TO anon, authenticated;

SELECT 'dgc_toolbox_talks ready' AS status, count(*) FROM public.dgc_toolbox_talks;
