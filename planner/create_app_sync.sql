-- The full Job Planner inside the Silverdale app (Ash, 11 Oct 2026): "Everything, with editing".
-- Claude's pages can't reach this database, so a task on Ash's Mac copies the Planner into the app and
-- pushes edits made in the app back here, using the DGC data share key (only its hash is stored, in
-- dgc_share_key_ok, from create_data_share.sql). Run create_data_share.sql first (already done 11 Oct).
-- Safe to run again.

-- Everything at once: { "<table>": { "columns": [...], "rows": [...] } } for every dgc_ table except the admin list.
CREATE OR REPLACE FUNCTION public.dgc_share_dump(p_key text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE t text; cols jsonb; rows jsonb; out jsonb := '{}'::jsonb;
BEGIN
  IF NOT public.dgc_share_key_ok(p_key) THEN RAISE EXCEPTION 'not allowed'; END IF;
  FOR t IN SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
           AND table_name LIKE 'dgc\_%' AND table_name <> 'dgc_app_admins' ORDER BY table_name LOOP
    SELECT coalesce(jsonb_agg(column_name ORDER BY ordinal_position), '[]'::jsonb) INTO cols
      FROM information_schema.columns WHERE table_schema = 'public' AND table_name = t;
    EXECUTE format('SELECT coalesce(jsonb_agg(to_jsonb(x)), ''[]''::jsonb) FROM public.%I x', t) INTO rows;
    out := out || jsonb_build_object(t, jsonb_build_object('columns', cols, 'rows', rows));
  END LOOP;
  RETURN out;
END $$;

-- One edit from the app: insert, upsert, update or delete on a dgc_ table (never the admin list).
-- p_row = the fields to write; p_match = equality match for update/delete (normally {"id": ...});
-- p_conflict = the unique column(s) for an upsert (default id). Returns the rows written.
CREATE OR REPLACE FUNCTION public.dgc_share_apply(p_key text, p_table text, p_op text, p_row jsonb, p_match jsonb, p_conflict text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE cols text; sets text; upd text; wh text; r jsonb;
BEGIN
  IF NOT public.dgc_share_key_ok(p_key) THEN RAISE EXCEPTION 'not allowed'; END IF;
  IF p_table !~ '^dgc_[a-z0-9_]+$' OR p_table = 'dgc_app_admins'
     OR NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' AND table_name = p_table) THEN
    RAISE EXCEPTION 'table not allowed: %', p_table;
  END IF;
  IF p_conflict IS NOT NULL AND p_conflict !~ '^[a-z0-9_]+(,[a-z0-9_]+)*$' THEN RAISE EXCEPTION 'bad conflict target'; END IF;
  IF p_row IS NOT NULL AND jsonb_typeof(p_row) = 'object' THEN
    SELECT string_agg(format('%I', c.column_name), ', ' ORDER BY c.ordinal_position),
           string_agg(format('%I = EXCLUDED.%I', c.column_name, c.column_name), ', ' ORDER BY c.ordinal_position),
           string_agg(format('%I = src.%I', c.column_name, c.column_name), ', ' ORDER BY c.ordinal_position)
      INTO cols, sets, upd
      FROM information_schema.columns c WHERE c.table_schema = 'public' AND c.table_name = p_table AND p_row ? c.column_name;
  END IF;
  IF p_match IS NOT NULL AND jsonb_typeof(p_match) = 'object' THEN
    SELECT string_agg(CASE WHEN p_match -> c.column_name = 'null'::jsonb THEN format('t.%I IS NULL', c.column_name)
                           ELSE format('t.%I = (jsonb_populate_record(NULL::public.%I, $2)).%I', c.column_name, p_table, c.column_name) END, ' AND ')
      INTO wh FROM information_schema.columns c WHERE c.table_schema = 'public' AND c.table_name = p_table AND p_match ? c.column_name;
  END IF;

  IF p_op = 'insert' THEN
    IF cols IS NULL THEN RAISE EXCEPTION 'nothing to insert'; END IF;
    EXECUTE format('WITH x AS (INSERT INTO public.%I AS t (%s) SELECT %s FROM jsonb_populate_record(NULL::public.%I, $1) RETURNING t.*) SELECT coalesce(jsonb_agg(to_jsonb(x)), ''[]''::jsonb) FROM x',
                   p_table, cols, cols, p_table) USING p_row, p_match INTO r;
  ELSIF p_op = 'upsert' THEN
    IF cols IS NULL THEN RAISE EXCEPTION 'nothing to upsert'; END IF;
    EXECUTE format('WITH x AS (INSERT INTO public.%I AS t (%s) SELECT %s FROM jsonb_populate_record(NULL::public.%I, $1) ON CONFLICT (%s) DO UPDATE SET %s RETURNING t.*) SELECT coalesce(jsonb_agg(to_jsonb(x)), ''[]''::jsonb) FROM x',
                   p_table, cols, cols, p_table, coalesce(p_conflict, 'id'), sets) USING p_row, p_match INTO r;
  ELSIF p_op = 'update' THEN
    IF cols IS NULL OR wh IS NULL THEN RAISE EXCEPTION 'update needs fields and a match'; END IF;
    EXECUTE format('WITH x AS (UPDATE public.%I AS t SET %s FROM jsonb_populate_record(NULL::public.%I, $1) AS src WHERE %s RETURNING t.*) SELECT coalesce(jsonb_agg(to_jsonb(x)), ''[]''::jsonb) FROM x',
                   p_table, upd, p_table, wh) USING p_row, p_match INTO r;
  ELSIF p_op = 'delete' THEN
    IF wh IS NULL THEN RAISE EXCEPTION 'delete needs a match'; END IF;
    EXECUTE format('WITH x AS (DELETE FROM public.%I AS t WHERE %s RETURNING t.*) SELECT coalesce(jsonb_agg(to_jsonb(x)), ''[]''::jsonb) FROM x',
                   p_table, wh) USING p_row, p_match INTO r;
  ELSE
    RAISE EXCEPTION 'unknown op %', p_op;
  END IF;
  RETURN r;
END $$;

GRANT EXECUTE ON FUNCTION public.dgc_share_dump(text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.dgc_share_apply(text, text, text, jsonb, jsonb, text) TO anon, authenticated;

NOTIFY pgrst, 'reload schema';
SELECT 'app sync ready' AS status;
