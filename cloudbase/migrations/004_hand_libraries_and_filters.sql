BEGIN;

-- A "database" in the product is a logical hand library. All users continue
-- to share the same PostgreSQL database, while user_id + RLS provide tenant
-- isolation and library_id provides future multi-library isolation.
CREATE TABLE IF NOT EXISTS public.hand_libraries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL DEFAULT auth.uid(),
  name text NOT NULL DEFAULT '我的牌谱',
  is_default boolean NOT NULL DEFAULT false,
  auto_save_enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hand_libraries_name_length CHECK (
    char_length(btrim(name)) BETWEEN 1 AND 80
  ),
  CONSTRAINT hand_libraries_owner_id_unique UNIQUE (user_id, id)
);

CREATE UNIQUE INDEX IF NOT EXISTS hand_libraries_one_default_per_owner
  ON public.hand_libraries (user_id)
  WHERE is_default;

CREATE INDEX IF NOT EXISTS hand_libraries_owner_created_idx
  ON public.hand_libraries (user_id, created_at DESC);

-- Keep the migration compatible with an interrupted/manual pre-creation of
-- hand_libraries that may not yet have the auto-save preference column.
ALTER TABLE public.hand_libraries
  ADD COLUMN IF NOT EXISTS auto_save_enabled boolean;
UPDATE public.hand_libraries
SET auto_save_enabled = true
WHERE auto_save_enabled IS NULL;
ALTER TABLE public.hand_libraries
  ALTER COLUMN auto_save_enabled SET DEFAULT true,
  ALTER COLUMN auto_save_enabled SET NOT NULL;

DROP TRIGGER IF EXISTS hand_libraries_set_updated_at ON public.hand_libraries;
CREATE TRIGGER hand_libraries_set_updated_at
  BEFORE UPDATE ON public.hand_libraries
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Backfill one default library for every owner already represented in the
-- application tables. Users with no application row yet are provisioned by
-- ensure_default_hand_library() on their first authenticated library action.
WITH owners AS (
  SELECT user_id FROM public.profiles
  UNION
  SELECT user_id FROM public.poker_accounts
  UNION
  SELECT user_id FROM public.privacy_consents
  UNION
  SELECT user_id FROM public.import_batches
  UNION
  SELECT user_id FROM public.sessions
  UNION
  SELECT user_id FROM public.hands
  UNION
  SELECT user_id FROM public.import_batch_hands
  UNION
  SELECT user_id FROM public.hand_libraries
)
INSERT INTO public.hand_libraries (id, user_id, name, is_default)
SELECT gen_random_uuid(), owners.user_id, '我的牌谱', true
FROM owners
WHERE owners.user_id IS NOT NULL
  AND btrim(owners.user_id) <> ''
  AND NOT EXISTS (
    SELECT 1
    FROM public.hand_libraries existing
    WHERE existing.user_id = owners.user_id
      AND existing.is_default
  )
ON CONFLICT DO NOTHING;

REVOKE ALL ON TABLE public.hand_libraries
FROM PUBLIC, anon, authenticated;

GRANT SELECT, INSERT, DELETE ON TABLE public.hand_libraries TO authenticated;
GRANT UPDATE (name, auto_save_enabled) ON TABLE public.hand_libraries TO authenticated;

ALTER TABLE public.hand_libraries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hand_libraries FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS hand_libraries_owner_select ON public.hand_libraries;
CREATE POLICY hand_libraries_owner_select
  ON public.hand_libraries
  FOR SELECT
  TO authenticated
  USING ((SELECT auth.uid()) IS NOT NULL AND user_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS hand_libraries_owner_insert ON public.hand_libraries;
CREATE POLICY hand_libraries_owner_insert
  ON public.hand_libraries
  FOR INSERT
  TO authenticated
  WITH CHECK ((SELECT auth.uid()) IS NOT NULL AND user_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS hand_libraries_owner_update ON public.hand_libraries;
CREATE POLICY hand_libraries_owner_update
  ON public.hand_libraries
  FOR UPDATE
  TO authenticated
  USING ((SELECT auth.uid()) IS NOT NULL AND user_id = (SELECT auth.uid()))
  WITH CHECK ((SELECT auth.uid()) IS NOT NULL AND user_id = (SELECT auth.uid()));

-- Default libraries cannot be deleted through the browser. A later, explicit
-- account/library deletion workflow can perform that destructive operation
-- through a controlled server-side path.
DROP POLICY IF EXISTS hand_libraries_owner_delete_nondefault ON public.hand_libraries;
CREATE POLICY hand_libraries_owner_delete_nondefault
  ON public.hand_libraries
  FOR DELETE
  TO authenticated
  USING (
    (SELECT auth.uid()) IS NOT NULL
    AND user_id = (SELECT auth.uid())
    AND NOT is_default
  );

-- This SECURITY INVOKER function is both an authenticated provisioning API and
-- the compatibility default for old clients that do not yet send library_id.
-- The table's FORCE RLS policies still apply inside the function.
CREATE OR REPLACE FUNCTION public.ensure_default_hand_library()
RETURNS uuid
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
DECLARE
  current_user_id text := auth.uid();
  default_library_id uuid;
BEGIN
  IF current_user_id IS NULL OR btrim(current_user_id) = '' THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'Authentication is required to provision a hand library.';
  END IF;

  SELECT library.id
  INTO default_library_id
  FROM public.hand_libraries AS library
  WHERE library.user_id = current_user_id
    AND library.is_default
  ORDER BY library.created_at, library.id
  LIMIT 1;

  IF default_library_id IS NOT NULL THEN
    RETURN default_library_id;
  END IF;

  BEGIN
    INSERT INTO public.hand_libraries (id, user_id, name, is_default)
    VALUES (gen_random_uuid(), current_user_id, '我的牌谱', true)
    RETURNING id INTO default_library_id;
  EXCEPTION WHEN unique_violation THEN
    -- Another browser tab may have provisioned the same default concurrently.
    SELECT library.id
    INTO default_library_id
    FROM public.hand_libraries AS library
    WHERE library.user_id = current_user_id
      AND library.is_default
    ORDER BY library.created_at, library.id
    LIMIT 1;
  END;

  IF default_library_id IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Unable to resolve the default hand library.';
  END IF;

  RETURN default_library_id;
END;
$$;

REVOKE ALL ON FUNCTION public.ensure_default_hand_library()
FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ensure_default_hand_library() TO authenticated;

-- Add the library partition key without a default first, so existing rows can
-- be backfilled deterministically before NOT NULL and compatibility defaults
-- are enabled.
ALTER TABLE public.import_batches
  ADD COLUMN IF NOT EXISTS library_id uuid;
ALTER TABLE public.sessions
  ADD COLUMN IF NOT EXISTS library_id uuid;
ALTER TABLE public.hands
  ADD COLUMN IF NOT EXISTS library_id uuid;
ALTER TABLE public.import_batch_hands
  ADD COLUMN IF NOT EXISTS library_id uuid;

UPDATE public.import_batches AS target
SET library_id = library.id
FROM public.hand_libraries AS library
WHERE target.library_id IS NULL
  AND library.user_id = target.user_id
  AND library.is_default;

UPDATE public.sessions AS target
SET library_id = library.id
FROM public.hand_libraries AS library
WHERE target.library_id IS NULL
  AND library.user_id = target.user_id
  AND library.is_default;

UPDATE public.hands AS target
SET library_id = library.id
FROM public.hand_libraries AS library
WHERE target.library_id IS NULL
  AND library.user_id = target.user_id
  AND library.is_default;

UPDATE public.import_batch_hands AS target
SET library_id = library.id
FROM public.hand_libraries AS library
WHERE target.library_id IS NULL
  AND library.user_id = target.user_id
  AND library.is_default;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.import_batches WHERE library_id IS NULL)
    OR EXISTS (SELECT 1 FROM public.sessions WHERE library_id IS NULL)
    OR EXISTS (SELECT 1 FROM public.hands WHERE library_id IS NULL)
    OR EXISTS (SELECT 1 FROM public.import_batch_hands WHERE library_id IS NULL)
  THEN
    RAISE EXCEPTION 'Cannot enforce library ownership: one or more existing rows were not backfilled.';
  END IF;
END;
$$;

ALTER TABLE public.import_batches
  ALTER COLUMN library_id SET DEFAULT public.ensure_default_hand_library(),
  ALTER COLUMN library_id SET NOT NULL;
ALTER TABLE public.sessions
  ALTER COLUMN library_id SET DEFAULT public.ensure_default_hand_library(),
  ALTER COLUMN library_id SET NOT NULL;
ALTER TABLE public.hands
  ALTER COLUMN library_id SET DEFAULT public.ensure_default_hand_library(),
  ALTER COLUMN library_id SET NOT NULL;
ALTER TABLE public.import_batch_hands
  ALTER COLUMN library_id SET DEFAULT public.ensure_default_hand_library(),
  ALTER COLUMN library_id SET NOT NULL;

-- Composite keys are deliberately redundant with the UUID primary keys. They
-- let foreign keys prove that a related batch/session/hand belongs to the same
-- user and the same logical library, rather than merely pointing at a valid ID.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.import_batches'::regclass
      AND conname = 'import_batches_owner_library_account_id_unique'
  ) THEN
    ALTER TABLE public.import_batches
      ADD CONSTRAINT import_batches_owner_library_account_id_unique
      UNIQUE (user_id, library_id, id, poker_account_id);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.sessions'::regclass
      AND conname = 'sessions_owner_library_account_id_unique'
  ) THEN
    ALTER TABLE public.sessions
      ADD CONSTRAINT sessions_owner_library_account_id_unique
      UNIQUE (user_id, library_id, id, poker_account_id);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.hands'::regclass
      AND conname = 'hands_owner_library_account_id_unique'
  ) THEN
    ALTER TABLE public.hands
      ADD CONSTRAINT hands_owner_library_account_id_unique
      UNIQUE (user_id, library_id, id, poker_account_id);
  END IF;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.import_batches'::regclass
      AND conname = 'import_batches_library_owner_fk'
  ) THEN
    ALTER TABLE public.import_batches
      ADD CONSTRAINT import_batches_library_owner_fk
      FOREIGN KEY (user_id, library_id)
      REFERENCES public.hand_libraries (user_id, id)
      ON DELETE CASCADE
      NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.sessions'::regclass
      AND conname = 'sessions_library_owner_fk'
  ) THEN
    ALTER TABLE public.sessions
      ADD CONSTRAINT sessions_library_owner_fk
      FOREIGN KEY (user_id, library_id)
      REFERENCES public.hand_libraries (user_id, id)
      ON DELETE CASCADE
      NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.hands'::regclass
      AND conname = 'hands_library_owner_fk'
  ) THEN
    ALTER TABLE public.hands
      ADD CONSTRAINT hands_library_owner_fk
      FOREIGN KEY (user_id, library_id)
      REFERENCES public.hand_libraries (user_id, id)
      ON DELETE CASCADE
      NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.import_batch_hands'::regclass
      AND conname = 'import_batch_hands_library_owner_fk'
  ) THEN
    ALTER TABLE public.import_batch_hands
      ADD CONSTRAINT import_batch_hands_library_owner_fk
      FOREIGN KEY (user_id, library_id)
      REFERENCES public.hand_libraries (user_id, id)
      ON DELETE CASCADE
      NOT VALID;
  END IF;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.sessions'::regclass
      AND conname = 'sessions_source_batch_owner_library_fk'
  ) THEN
    ALTER TABLE public.sessions
      ADD CONSTRAINT sessions_source_batch_owner_library_fk
      FOREIGN KEY (user_id, library_id, source_import_batch_id, poker_account_id)
      REFERENCES public.import_batches (user_id, library_id, id, poker_account_id)
      ON DELETE NO ACTION
      DEFERRABLE INITIALLY DEFERRED
      NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.hands'::regclass
      AND conname = 'hands_session_owner_library_account_fk'
  ) THEN
    ALTER TABLE public.hands
      ADD CONSTRAINT hands_session_owner_library_account_fk
      FOREIGN KEY (user_id, library_id, session_id, poker_account_id)
      REFERENCES public.sessions (user_id, library_id, id, poker_account_id)
      ON DELETE CASCADE
      NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.import_batch_hands'::regclass
      AND conname = 'import_batch_hands_batch_owner_library_account_fk'
  ) THEN
    ALTER TABLE public.import_batch_hands
      ADD CONSTRAINT import_batch_hands_batch_owner_library_account_fk
      FOREIGN KEY (user_id, library_id, import_batch_id, poker_account_id)
      REFERENCES public.import_batches (user_id, library_id, id, poker_account_id)
      ON DELETE CASCADE
      NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.import_batch_hands'::regclass
      AND conname = 'import_batch_hands_hand_owner_library_account_fk'
  ) THEN
    ALTER TABLE public.import_batch_hands
      ADD CONSTRAINT import_batch_hands_hand_owner_library_account_fk
      FOREIGN KEY (user_id, library_id, hand_id, poker_account_id)
      REFERENCES public.hands (user_id, library_id, id, poker_account_id)
      ON DELETE CASCADE
      NOT VALID;
  END IF;
END;
$$;

-- VALIDATE is safe to repeat and keeps the add-constraint lock shorter than a
-- directly validated FK on a populated table.
ALTER TABLE public.import_batches
  VALIDATE CONSTRAINT import_batches_library_owner_fk;
ALTER TABLE public.sessions
  VALIDATE CONSTRAINT sessions_library_owner_fk;
ALTER TABLE public.hands
  VALIDATE CONSTRAINT hands_library_owner_fk;
ALTER TABLE public.import_batch_hands
  VALIDATE CONSTRAINT import_batch_hands_library_owner_fk;
ALTER TABLE public.sessions
  VALIDATE CONSTRAINT sessions_source_batch_owner_library_fk;
ALTER TABLE public.hands
  VALIDATE CONSTRAINT hands_session_owner_library_account_fk;
ALTER TABLE public.import_batch_hands
  VALIDATE CONSTRAINT import_batch_hands_batch_owner_library_account_fk;
ALTER TABLE public.import_batch_hands
  VALIDATE CONSTRAINT import_batch_hands_hand_owner_library_account_fk;

-- A hand is unique inside a logical library. The same source hand may be
-- intentionally imported into another library owned by the same user.
ALTER TABLE public.hands
  DROP CONSTRAINT IF EXISTS hands_external_id_unique;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.hands'::regclass
      AND conname = 'hands_owner_library_external_id_unique'
  ) THEN
    ALTER TABLE public.hands
      ADD CONSTRAINT hands_owner_library_external_id_unique
      UNIQUE (user_id, library_id, platform, external_hand_id);
  END IF;
END;
$$;

DROP INDEX IF EXISTS public.hands_owner_content_sha_unique;
CREATE UNIQUE INDEX IF NOT EXISTS hands_owner_library_content_sha_unique
  ON public.hands (user_id, library_id, content_sha256);

DROP INDEX IF EXISTS public.import_batches_owner_idempotency_unique;
CREATE UNIQUE INDEX IF NOT EXISTS import_batches_owner_library_idempotency_unique
  ON public.import_batches (user_id, library_id, idempotency_key);

CREATE INDEX IF NOT EXISTS import_batches_owner_library_created_idx
  ON public.import_batches (user_id, library_id, created_at DESC);
CREATE INDEX IF NOT EXISTS import_batches_owner_library_status_idx
  ON public.import_batches (user_id, library_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS sessions_owner_library_started_idx
  ON public.sessions (user_id, library_id, started_at DESC NULLS LAST, created_at DESC);
CREATE INDEX IF NOT EXISTS hands_owner_library_played_idx
  ON public.hands (user_id, library_id, played_at DESC NULLS LAST, external_hand_id);
CREATE INDEX IF NOT EXISTS hands_owner_library_stakes_idx
  ON public.hands (user_id, library_id, currency, big_blind, played_at DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS hands_owner_library_stakes_label_idx
  ON public.hands (user_id, library_id, stakes_label, played_at DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS import_batch_hands_owner_library_batch_idx
  ON public.import_batch_hands (user_id, library_id, import_batch_id, outcome);

-- Normalized filter facets. Raw descriptor/name columns retain enough source
-- context to reclassify an unfamiliar GG variant later without scanning every
-- complete hand-history line in application code.
ALTER TABLE public.hands
  ADD COLUMN IF NOT EXISTS game_variant text,
  ADD COLUMN IF NOT EXISTS betting_structure text,
  ADD COLUMN IF NOT EXISTS table_type text,
  ADD COLUMN IF NOT EXISTS max_players smallint,
  ADD COLUMN IF NOT EXISTS game_descriptor_raw text,
  ADD COLUMN IF NOT EXISTS table_name_raw text,
  ADD COLUMN IF NOT EXISTS analysis_supported boolean;

CREATE OR REPLACE FUNCTION public.populate_hand_game_metadata()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  normalized_text text;
  header_line text;
  table_line text;
  descriptor text;
  descriptor_lower text;
  source_table_name text;
  max_players_text text;
  derived_variant text := 'unknown';
  derived_structure text := 'unknown';
  derived_table_type text := 'unknown';
BEGIN
  normalized_text := replace(replace(COALESCE(NEW.raw_text, ''), E'\r\n', E'\n'), E'\r', E'\n');
  header_line := split_part(normalized_text, E'\n', 1);
  table_line := split_part(normalized_text, E'\n', 2);
  descriptor := NULLIF(
    btrim(substring(header_line FROM '^[^:]+:[[:space:]]*(.*)[[:space:]]+[(]')),
    ''
  );
  descriptor_lower := lower(COALESCE(descriptor, ''));
  source_table_name := NULLIF(
    btrim(substring(table_line FROM '^Table[[:space:]]+''([^'']+)''')),
    ''
  );
  max_players_text := substring(table_line FROM '([0-9]{1,2})-max');

  IF descriptor_lower LIKE '%short deck%' THEN
    derived_variant := 'short_deck';
  ELSIF descriptor_lower LIKE '%6 card omaha%'
    OR descriptor_lower LIKE '%omaha 6 card%'
    OR descriptor_lower LIKE '%omaha 6%' THEN
    derived_variant := 'omaha6';
  ELSIF descriptor_lower LIKE '%5 card omaha%'
    OR descriptor_lower LIKE '%omaha 5 card%'
    OR descriptor_lower LIKE '%omaha 5%' THEN
    derived_variant := 'omaha5';
  ELSIF descriptor_lower LIKE '%omaha%' THEN
    derived_variant := 'omaha4';
  ELSIF descriptor_lower LIKE '%hold''em%'
    OR descriptor_lower LIKE '%holdem%' THEN
    derived_variant := 'holdem';
  END IF;

  IF descriptor_lower LIKE '%no limit%' THEN
    derived_structure := 'no_limit';
  ELSIF descriptor_lower LIKE '%pot limit%' THEN
    derived_structure := 'pot_limit';
  ELSIF descriptor_lower LIKE '%limit%' THEN
    derived_structure := 'fixed_limit';
  END IF;

  IF lower(COALESCE(source_table_name, '')) LIKE 'rushandcash%' THEN
    derived_table_type := 'rush_cash';
  ELSIF lower(COALESCE(source_table_name, '')) LIKE '%allinorfold%'
    OR lower(COALESCE(source_table_name, '')) LIKE '%all-in-or-fold%'
    OR lower(COALESCE(source_table_name, '')) LIKE '%all in or fold%' THEN
    derived_table_type := 'all_in_or_fold';
  ELSIF lower(COALESCE(source_table_name, '')) LIKE '%tournament%'
    OR lower(COALESCE(source_table_name, '')) LIKE '%spinandgold%'
    OR lower(COALESCE(source_table_name, '')) LIKE '%spin and gold%'
    OR descriptor_lower LIKE '%tournament%' THEN
    derived_table_type := 'tournament';
  ELSIF source_table_name IS NOT NULL THEN
    derived_table_type := 'regular';
  END IF;

  IF NEW.game_variant IS NULL OR NEW.game_variant = 'unknown' THEN
    NEW.game_variant := derived_variant;
  END IF;
  IF NEW.betting_structure IS NULL OR NEW.betting_structure = 'unknown' THEN
    NEW.betting_structure := derived_structure;
  END IF;
  IF NEW.table_type IS NULL OR NEW.table_type = 'unknown' THEN
    NEW.table_type := derived_table_type;
  END IF;
  IF NEW.max_players IS NULL
    AND max_players_text IS NOT NULL
    AND max_players_text ~ '^[0-9]{1,2}$'
    AND max_players_text::integer BETWEEN 2 AND 10 THEN
    NEW.max_players := max_players_text::smallint;
  END IF;
  IF NEW.game_descriptor_raw IS NULL THEN
    NEW.game_descriptor_raw := left(descriptor, 256);
  ELSE
    NEW.game_descriptor_raw := left(NEW.game_descriptor_raw, 256);
  END IF;
  IF NEW.table_name_raw IS NULL THEN
    NEW.table_name_raw := left(source_table_name, 256);
  ELSE
    NEW.table_name_raw := left(NEW.table_name_raw, 256);
  END IF;

  -- The current analyzer is calibrated only for no-limit Texas Hold'em.
  NEW.analysis_supported := (
    NEW.game_variant = 'holdem'
    AND NEW.betting_structure = 'no_limit'
  );

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.populate_hand_game_metadata()
FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS hands_populate_game_metadata ON public.hands;
CREATE TRIGGER hands_populate_game_metadata
  BEFORE INSERT OR UPDATE OF raw_text ON public.hands
  FOR EACH ROW EXECUTE FUNCTION public.populate_hand_game_metadata();

-- Fire the metadata trigger for legacy rows. This necessarily touches the
-- existing hand rows once; subsequent runs skip the update.
UPDATE public.hands
SET raw_text = raw_text
WHERE game_variant IS NULL
  OR betting_structure IS NULL
  OR table_type IS NULL
  OR analysis_supported IS NULL;

UPDATE public.hands
SET game_variant = COALESCE(game_variant, 'unknown'),
    betting_structure = COALESCE(betting_structure, 'unknown'),
    table_type = COALESCE(table_type, 'unknown'),
    analysis_supported = COALESCE(analysis_supported, false)
WHERE game_variant IS NULL
  OR betting_structure IS NULL
  OR table_type IS NULL
  OR analysis_supported IS NULL;

ALTER TABLE public.hands
  ALTER COLUMN game_variant SET DEFAULT 'unknown',
  ALTER COLUMN game_variant SET NOT NULL,
  ALTER COLUMN betting_structure SET DEFAULT 'unknown',
  ALTER COLUMN betting_structure SET NOT NULL,
  ALTER COLUMN table_type SET DEFAULT 'unknown',
  ALTER COLUMN table_type SET NOT NULL,
  ALTER COLUMN analysis_supported SET DEFAULT false,
  ALTER COLUMN analysis_supported SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.hands'::regclass
      AND conname = 'hands_game_variant_format'
  ) THEN
    ALTER TABLE public.hands
      ADD CONSTRAINT hands_game_variant_format
      CHECK (game_variant ~ '^[a-z0-9_]{2,40}$') NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.hands'::regclass
      AND conname = 'hands_betting_structure_format'
  ) THEN
    ALTER TABLE public.hands
      ADD CONSTRAINT hands_betting_structure_format
      CHECK (betting_structure ~ '^[a-z0-9_]{2,40}$') NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.hands'::regclass
      AND conname = 'hands_table_type_format'
  ) THEN
    ALTER TABLE public.hands
      ADD CONSTRAINT hands_table_type_format
      CHECK (table_type ~ '^[a-z0-9_]{2,40}$') NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.hands'::regclass
      AND conname = 'hands_max_players_valid'
  ) THEN
    ALTER TABLE public.hands
      ADD CONSTRAINT hands_max_players_valid
      CHECK (max_players IS NULL OR max_players BETWEEN 2 AND 10) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.hands'::regclass
      AND conname = 'hands_game_descriptor_raw_length'
  ) THEN
    ALTER TABLE public.hands
      ADD CONSTRAINT hands_game_descriptor_raw_length
      CHECK (game_descriptor_raw IS NULL OR char_length(game_descriptor_raw) <= 256) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.hands'::regclass
      AND conname = 'hands_table_name_raw_length'
  ) THEN
    ALTER TABLE public.hands
      ADD CONSTRAINT hands_table_name_raw_length
      CHECK (table_name_raw IS NULL OR char_length(table_name_raw) <= 256) NOT VALID;
  END IF;
END;
$$;

ALTER TABLE public.hands VALIDATE CONSTRAINT hands_game_variant_format;
ALTER TABLE public.hands VALIDATE CONSTRAINT hands_betting_structure_format;
ALTER TABLE public.hands VALIDATE CONSTRAINT hands_table_type_format;
ALTER TABLE public.hands VALIDATE CONSTRAINT hands_max_players_valid;
ALTER TABLE public.hands VALIDATE CONSTRAINT hands_game_descriptor_raw_length;
ALTER TABLE public.hands VALIDATE CONSTRAINT hands_table_name_raw_length;

CREATE INDEX IF NOT EXISTS hands_owner_library_game_filter_idx
  ON public.hands (
    user_id,
    library_id,
    game_variant,
    betting_structure,
    table_type,
    max_players,
    played_at DESC NULLS LAST
  );

CREATE INDEX IF NOT EXISTS hands_owner_library_supported_played_idx
  ON public.hands (user_id, library_id, played_at DESC NULLS LAST)
  WHERE analysis_supported;

COMMIT;
