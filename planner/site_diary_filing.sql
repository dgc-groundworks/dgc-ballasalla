-- Site Diary: file every entry as a PDF into the job's folder on the shared drive (Ash, 20 Oct 2026).
-- "Make sure you save everything to the job pack... when somebody does log in, all the backed-up ones save there to the right job."
-- The filing script on Ash's Mac (scheduled task site-diary-file-to-job-folders) uses the same private key as the accident filing.
-- Run once in the Supabase SQL Editor for the Job Planner project (vigdtpcgeqenznuakdwz).

ALTER TABLE public.dgc_site_diary ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now();
ALTER TABLE public.dgc_site_diary ADD COLUMN IF NOT EXISTS filed_at   timestamptz;
UPDATE public.dgc_site_diary SET updated_at = coalesce(created_at, now()) WHERE updated_at IS NULL;

-- An edit after filing means the PDF is filed again (same file, replaced).
CREATE OR REPLACE FUNCTION public.dgc_site_diary_touch() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.filed_at IS DISTINCT FROM OLD.filed_at) AND row(NEW.site, NEW.diary_date, NEW.author, NEW.weather, NEW.plant, NEW.workers, NEW.work_done, NEW.issues, NEW.visitors, NEW.notes)
       IS NOT DISTINCT FROM row(OLD.site, OLD.diary_date, OLD.author, OLD.weather, OLD.plant, OLD.workers, OLD.work_done, OLD.issues, OLD.visitors, OLD.notes) THEN
    RETURN NEW;  -- only the filing stamp changed
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS dgc_site_diary_touch ON public.dgc_site_diary;
CREATE TRIGGER dgc_site_diary_touch BEFORE UPDATE ON public.dgc_site_diary
  FOR EACH ROW EXECUTE FUNCTION public.dgc_site_diary_touch();

-- Entries not filed yet, or changed since they were filed
CREATE OR REPLACE FUNCTION public.dgc_site_diary_to_file(p_key text)
RETURNS SETOF public.dgc_site_diary
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.dgc_accident_key_ok(p_key) THEN RAISE EXCEPTION 'not allowed'; END IF;
  RETURN QUERY SELECT * FROM public.dgc_site_diary
    WHERE filed_at IS NULL OR updated_at > filed_at
    ORDER BY diary_date, created_at;
END $$;

CREATE OR REPLACE FUNCTION public.dgc_site_diary_mark_filed(p_key text, p_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.dgc_accident_key_ok(p_key) THEN RAISE EXCEPTION 'not allowed'; END IF;
  UPDATE public.dgc_site_diary SET filed_at = now() WHERE id = p_id;
END $$;

GRANT EXECUTE ON FUNCTION public.dgc_site_diary_to_file(text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.dgc_site_diary_mark_filed(text, uuid) TO anon, authenticated;

SELECT 'site diary filing ready' AS status, count(*) AS entries, count(*) FILTER (WHERE filed_at IS NULL) AS to_file FROM public.dgc_site_diary;
