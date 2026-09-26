CREATE OR REPLACE FUNCTION public.wareongo_image_urls(raw_media jsonb, raw_photos text)
RETURNS text[] LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE SET search_path = pg_catalog AS $$
DECLARE m jsonb := raw_media; p jsonb; entry jsonb; value text; part text; path text;
  result text[] := ARRAY[]::text[]; i integer;
BEGIN
  FOR i IN 1..2 LOOP
    EXIT WHEN jsonb_typeof(m) IS DISTINCT FROM 'string';
    BEGIN m := (m #>> '{}')::jsonb; EXCEPTION WHEN invalid_text_representation THEN EXIT; END;
  END LOOP;
  IF jsonb_typeof(m->'images') = 'array' THEN p := m->'images';
  ELSE
    p := to_jsonb(raw_photos);
    FOR i IN 1..2 LOOP
      EXIT WHEN jsonb_typeof(p) IS DISTINCT FROM 'string';
      BEGIN p := (p #>> '{}')::jsonb; EXCEPTION WHEN invalid_text_representation THEN EXIT; END;
    END LOOP;
  END IF;
  IF p IS NULL THEN RETURN result; END IF;
  IF jsonb_typeof(p) <> 'array' THEN p := jsonb_build_array(p); END IF;
  FOR entry IN SELECT jsonb_array_elements(p) LOOP
    CONTINUE WHEN jsonb_typeof(entry) <> 'string';
    value := entry #>> '{}';
    FOREACH part IN ARRAY regexp_split_to_array(value, ',\s*(?=https?://)', 'i') LOOP
      part := btrim(part);
      CONTINUE WHEN part !~* '^https?://[^/\s@?#]+/.+';
      path := regexp_replace(part, '[?#].*$', '');
      IF (path ~* '\.(jpe?g|png|webp|gif|avif|bmp|tiff?|heic|heif|svg)$' OR path !~ '\.[^/.]+$')
        AND NOT (part = ANY(result)) THEN result := array_append(result, part); END IF;
    END LOOP;
  END LOOP;
  RETURN result;
END $$;
