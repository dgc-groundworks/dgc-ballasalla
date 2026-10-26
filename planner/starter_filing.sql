-- New starter filing (Ash, 26 Oct 2026): "make that".
-- When a starter sends the online form, the hourly task on Ash's Mac saves their answers as a PDF and every document
-- they uploaded into HR & People/Employees/<name>/, drafts their contract from the V3 template (never sent), and marks it done.
-- Same private key as the accident, site diary and toolbox filing. Additive only.
-- Run once in the Supabase SQL Editor for the Job Planner project (vigdtpcgeqenznuakdwz).

ALTER TABLE public.dgc_new_starters ADD COLUMN IF NOT EXISTS hr_filed_on timestamptz;      -- answers PDF filed
ALTER TABLE public.dgc_new_starters ADD COLUMN IF NOT EXISTS contract_drafted_on timestamptz;

-- Starters whose form is in and not yet filed (or sent again since), with their documents not yet copied
CREATE OR REPLACE FUNCTION public.dgc_starters_to_file(p_key text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.dgc_accident_key_ok(p_key) THEN RAISE EXCEPTION 'not allowed'; END IF;
  RETURN coalesce((
    SELECT jsonb_agg(to_jsonb(s) - 'form_token' || jsonb_build_object('docs', coalesce((
      SELECT jsonb_agg(jsonb_build_object('id', d.id, 'kind', d.kind, 'title', d.title, 'file_path', d.file_path) ORDER BY d.created_at)
      FROM public.dgc_new_starter_docs d WHERE d.starter_id = s.id AND d.removed_on IS NULL AND d.hr_copied_on IS NULL), '[]'::jsonb)))
    FROM public.dgc_new_starters s
    WHERE s.form_submitted_on IS NOT NULL
      AND (s.hr_filed_on IS NULL OR s.form_submitted_on > s.hr_filed_on
           OR EXISTS (SELECT 1 FROM public.dgc_new_starter_docs d WHERE d.starter_id = s.id AND d.removed_on IS NULL AND d.hr_copied_on IS NULL))
  ), '[]'::jsonb);
END $$;

CREATE OR REPLACE FUNCTION public.dgc_starter_mark_filed(p_key text, p_id uuid, p_contract boolean)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.dgc_accident_key_ok(p_key) THEN RAISE EXCEPTION 'not allowed'; END IF;
  UPDATE public.dgc_new_starters SET hr_filed_on = now(),
    contract_drafted_on = CASE WHEN p_contract THEN now() ELSE contract_drafted_on END WHERE id = p_id;
END $$;

CREATE OR REPLACE FUNCTION public.dgc_starter_doc_mark_copied(p_key text, p_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.dgc_accident_key_ok(p_key) THEN RAISE EXCEPTION 'not allowed'; END IF;
  UPDATE public.dgc_new_starter_docs SET hr_copied_on = now() WHERE id = p_id;
END $$;

GRANT EXECUTE ON FUNCTION public.dgc_starters_to_file(text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.dgc_starter_mark_filed(text, uuid, boolean) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.dgc_starter_doc_mark_copied(text, uuid) TO anon, authenticated;

-- The Mac task downloads the starter's documents with the same private key, sent as the header x-dgc-key.
CREATE OR REPLACE FUNCTION public.dgc_filing_header_ok() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT public.dgc_accident_key_ok(coalesce(current_setting('request.headers', true), '{}')::json ->> 'x-dgc-key');
$$;
GRANT EXECUTE ON FUNCTION public.dgc_filing_header_ok() TO anon, authenticated;
DROP POLICY IF EXISTS "Starter docs: filing task read" ON storage.objects;
CREATE POLICY "Starter docs: filing task read" ON storage.objects FOR SELECT TO anon
  USING (bucket_id = 'starter-docs' AND public.dgc_filing_header_ok());

SELECT 'starter filing ready' AS status, count(*) FILTER (WHERE form_submitted_on IS NOT NULL) AS forms_in FROM public.dgc_new_starters;
