BEGIN;

-- CloudBase PG exposes auth.uid() as the authenticated JWT subject (text).
-- Keep ownership columns server-derived so clients never need to submit them.

CREATE TABLE public.profiles (
  user_id text PRIMARY KEY DEFAULT auth.uid(),
  display_name text,
  locale text NOT NULL DEFAULT 'zh-CN',
  timezone text NOT NULL DEFAULT 'Asia/Shanghai',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT profiles_display_name_length CHECK (
    display_name IS NULL OR char_length(display_name) BETWEEN 1 AND 80
  )
);

CREATE TABLE public.poker_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL DEFAULT auth.uid(),
  platform text NOT NULL DEFAULT 'ggpoker',
  screen_name text NOT NULL,
  timezone text NOT NULL DEFAULT 'Asia/Shanghai',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT poker_accounts_platform_format CHECK (
    platform = lower(platform) AND platform ~ '^[a-z0-9_-]{2,32}$'
  ),
  CONSTRAINT poker_accounts_screen_name_length CHECK (
    char_length(screen_name) BETWEEN 1 AND 80
  ),
  CONSTRAINT poker_accounts_owner_id_unique UNIQUE (user_id, id),
  CONSTRAINT poker_accounts_owner_platform_id_unique UNIQUE (user_id, id, platform),
  CONSTRAINT poker_accounts_screen_name_unique UNIQUE (user_id, platform, screen_name)
);

CREATE TABLE public.privacy_consents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL DEFAULT auth.uid(),
  purpose text NOT NULL,
  policy_version text NOT NULL,
  granted boolean NOT NULL DEFAULT true,
  source text NOT NULL DEFAULT 'web',
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  consented_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT privacy_consents_purpose_length CHECK (
    char_length(purpose) BETWEEN 1 AND 64
  ),
  CONSTRAINT privacy_consents_policy_version_length CHECK (
    char_length(policy_version) BETWEEN 1 AND 40
  ),
  CONSTRAINT privacy_consents_evidence_object CHECK (
    jsonb_typeof(evidence) = 'object'
  ),
  CONSTRAINT privacy_consents_revocation_order CHECK (
    revoked_at IS NULL OR revoked_at >= consented_at
  ),
  CONSTRAINT privacy_consents_active_grant CHECK (
    granted = true AND revoked_at IS NULL
  ),
  CONSTRAINT privacy_consents_owner_id_unique UNIQUE (user_id, id),
  CONSTRAINT privacy_consents_version_unique UNIQUE (user_id, purpose, policy_version)
);

CREATE TABLE public.import_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL DEFAULT auth.uid(),
  poker_account_id uuid NOT NULL,
  privacy_consent_id uuid NOT NULL,
  idempotency_key text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  parser_version text NOT NULL,
  source_manifest jsonb NOT NULL DEFAULT '{}'::jsonb,
  total_count integer NOT NULL DEFAULT 0,
  inserted_count integer NOT NULL DEFAULT 0,
  duplicate_count integer NOT NULL DEFAULT 0,
  conflict_count integer NOT NULL DEFAULT 0,
  error_count integer NOT NULL DEFAULT 0,
  error_message text,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT import_batches_status_valid CHECK (
    status IN ('pending', 'uploading', 'processing', 'completed', 'failed', 'cancelled')
  ),
  CONSTRAINT import_batches_manifest_object CHECK (
    jsonb_typeof(source_manifest) = 'object'
  ),
  CONSTRAINT import_batches_counts_nonnegative CHECK (
    total_count >= 0
    AND inserted_count >= 0
    AND duplicate_count >= 0
    AND conflict_count >= 0
    AND error_count >= 0
  ),
  CONSTRAINT import_batches_completion_order CHECK (
    completed_at IS NULL OR started_at IS NULL OR completed_at >= started_at
  ),
  CONSTRAINT import_batches_idempotency_key_length CHECK (
    char_length(idempotency_key) BETWEEN 8 AND 160
  ),
  CONSTRAINT import_batches_owner_id_unique UNIQUE (user_id, id),
  CONSTRAINT import_batches_owner_account_id_unique UNIQUE (user_id, id, poker_account_id),
  CONSTRAINT import_batches_account_owner_fk
    FOREIGN KEY (user_id, poker_account_id)
    REFERENCES public.poker_accounts (user_id, id)
    ON DELETE CASCADE,
  CONSTRAINT import_batches_consent_owner_fk
    FOREIGN KEY (user_id, privacy_consent_id)
    REFERENCES public.privacy_consents (user_id, id)
    ON DELETE RESTRICT
);

CREATE UNIQUE INDEX import_batches_owner_idempotency_unique
  ON public.import_batches (user_id, idempotency_key);

CREATE TABLE public.sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL DEFAULT auth.uid(),
  poker_account_id uuid NOT NULL,
  source_import_batch_id uuid,
  name text,
  started_at timestamptz,
  ended_at timestamptz,
  timezone text NOT NULL DEFAULT 'Asia/Shanghai',
  hand_count integer NOT NULL DEFAULT 0,
  tp_start numeric(20, 6),
  tp_end numeric(20, 6),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sessions_name_length CHECK (
    name IS NULL OR char_length(name) BETWEEN 1 AND 120
  ),
  CONSTRAINT sessions_time_order CHECK (
    ended_at IS NULL OR started_at IS NULL OR ended_at >= started_at
  ),
  CONSTRAINT sessions_hand_count_nonnegative CHECK (hand_count >= 0),
  CONSTRAINT sessions_metadata_object CHECK (jsonb_typeof(metadata) = 'object'),
  CONSTRAINT sessions_owner_id_unique UNIQUE (user_id, id),
  CONSTRAINT sessions_owner_account_id_unique UNIQUE (user_id, id, poker_account_id),
  CONSTRAINT sessions_account_owner_fk
    FOREIGN KEY (user_id, poker_account_id)
    REFERENCES public.poker_accounts (user_id, id)
    ON DELETE CASCADE,
  CONSTRAINT sessions_source_batch_owner_fk
    FOREIGN KEY (user_id, source_import_batch_id, poker_account_id)
    REFERENCES public.import_batches (user_id, id, poker_account_id)
    ON DELETE NO ACTION
    DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE public.hands (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL DEFAULT auth.uid(),
  poker_account_id uuid NOT NULL,
  session_id uuid NOT NULL,
  platform text NOT NULL DEFAULT 'ggpoker',
  external_hand_id text NOT NULL,
  content_sha256 text NOT NULL,
  raw_text text NOT NULL,
  source_object_key text,
  source_ordinal integer,
  source_date_text text,
  played_at timestamptz,
  currency text NOT NULL DEFAULT 'USD',
  small_blind numeric(20, 6),
  big_blind numeric(20, 6) NOT NULL,
  stakes_label text,
  hero_position text,
  hero_cards text[] NOT NULL DEFAULT ARRAY[]::text[],
  starting_hand_key text,
  board_cards text[] NOT NULL DEFAULT ARRAY[]::text[],
  hand_value text,
  total_pot numeric(20, 6) NOT NULL DEFAULT 0,
  hero_profit numeric(20, 6) NOT NULL DEFAULT 0,
  hero_profit_bb numeric(20, 8) NOT NULL DEFAULT 0,
  hand_rake numeric(20, 6) NOT NULL DEFAULT 0,
  hand_jackpot numeric(20, 6) NOT NULL DEFAULT 0,
  hero_rake_share numeric(20, 6) NOT NULL DEFAULT 0,
  hero_jackpot_share numeric(20, 6) NOT NULL DEFAULT 0,
  saw_flop boolean NOT NULL DEFAULT false,
  went_to_showdown boolean NOT NULL DEFAULT false,
  won_at_showdown boolean NOT NULL DEFAULT false,
  won_when_saw_flop boolean NOT NULL DEFAULT false,
  preflop_facts jsonb NOT NULL DEFAULT '{}'::jsonb,
  postflop_facts jsonb NOT NULL DEFAULT '{}'::jsonb,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  parser_version text NOT NULL,
  metric_version text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hands_platform_format CHECK (
    platform = lower(platform) AND platform ~ '^[a-z0-9_-]{2,32}$'
  ),
  CONSTRAINT hands_external_hand_id_length CHECK (
    char_length(external_hand_id) BETWEEN 1 AND 128
  ),
  CONSTRAINT hands_content_sha256_format CHECK (
    content_sha256 ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT hands_raw_text_size CHECK (
    octet_length(raw_text) BETWEEN 1 AND 262144
  ),
  CONSTRAINT hands_source_ordinal_nonnegative CHECK (
    source_ordinal IS NULL OR source_ordinal >= 0
  ),
  CONSTRAINT hands_currency_format CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT hands_blinds_valid CHECK (
    big_blind > 0 AND (small_blind IS NULL OR small_blind >= 0)
  ),
  CONSTRAINT hands_amounts_nonnegative CHECK (
    total_pot >= 0
    AND hand_rake >= 0
    AND hand_jackpot >= 0
    AND hero_rake_share >= 0
    AND hero_jackpot_share >= 0
  ),
  CONSTRAINT hands_hero_cards_count CHECK (cardinality(hero_cards) <= 2),
  CONSTRAINT hands_board_cards_count CHECK (cardinality(board_cards) <= 5),
  CONSTRAINT hands_preflop_facts_object CHECK (jsonb_typeof(preflop_facts) = 'object'),
  CONSTRAINT hands_postflop_facts_object CHECK (jsonb_typeof(postflop_facts) = 'object'),
  CONSTRAINT hands_detail_object CHECK (jsonb_typeof(detail) = 'object'),
  CONSTRAINT hands_owner_id_unique UNIQUE (user_id, id),
  CONSTRAINT hands_owner_account_id_unique UNIQUE (user_id, id, poker_account_id),
  CONSTRAINT hands_external_id_unique UNIQUE (user_id, platform, external_hand_id),
  CONSTRAINT hands_account_owner_platform_fk
    FOREIGN KEY (user_id, poker_account_id, platform)
    REFERENCES public.poker_accounts (user_id, id, platform)
    ON DELETE CASCADE,
  CONSTRAINT hands_session_owner_account_fk
    FOREIGN KEY (user_id, session_id, poker_account_id)
    REFERENCES public.sessions (user_id, id, poker_account_id)
    ON DELETE CASCADE
);

CREATE TABLE public.import_batch_hands (
  user_id text NOT NULL DEFAULT auth.uid(),
  poker_account_id uuid NOT NULL,
  import_batch_id uuid NOT NULL,
  hand_id uuid NOT NULL,
  outcome text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (import_batch_id, hand_id),
  CONSTRAINT import_batch_hands_outcome_valid CHECK (
    outcome IN ('inserted', 'duplicate', 'conflict', 'rejected')
  ),
  CONSTRAINT import_batch_hands_batch_owner_account_fk
    FOREIGN KEY (user_id, import_batch_id, poker_account_id)
    REFERENCES public.import_batches (user_id, id, poker_account_id)
    ON DELETE CASCADE,
  CONSTRAINT import_batch_hands_hand_owner_account_fk
    FOREIGN KEY (user_id, hand_id, poker_account_id)
    REFERENCES public.hands (user_id, id, poker_account_id)
    ON DELETE CASCADE
);

CREATE INDEX poker_accounts_owner_created_idx
  ON public.poker_accounts (user_id, created_at DESC);
CREATE INDEX privacy_consents_owner_created_idx
  ON public.privacy_consents (user_id, created_at DESC);
CREATE INDEX import_batches_owner_created_idx
  ON public.import_batches (user_id, created_at DESC);
CREATE INDEX import_batches_owner_status_idx
  ON public.import_batches (user_id, status, created_at DESC);
CREATE INDEX sessions_owner_started_idx
  ON public.sessions (user_id, started_at DESC NULLS LAST);
CREATE INDEX sessions_owner_account_started_idx
  ON public.sessions (user_id, poker_account_id, started_at DESC NULLS LAST);
CREATE INDEX hands_owner_played_idx
  ON public.hands (user_id, played_at DESC NULLS LAST, external_hand_id);
CREATE INDEX hands_owner_account_played_idx
  ON public.hands (user_id, poker_account_id, played_at DESC NULLS LAST);
CREATE INDEX hands_owner_session_played_idx
  ON public.hands (user_id, session_id, played_at, external_hand_id);
CREATE INDEX hands_owner_stakes_idx
  ON public.hands (user_id, stakes_label, played_at DESC NULLS LAST);
CREATE INDEX hands_owner_position_idx
  ON public.hands (user_id, hero_position, played_at DESC NULLS LAST);
CREATE INDEX hands_owner_starting_hand_idx
  ON public.hands (user_id, starting_hand_key, played_at DESC NULLS LAST);
CREATE INDEX hands_board_cards_gin_idx
  ON public.hands USING gin (board_cards);
CREATE INDEX import_batch_hands_owner_batch_idx
  ON public.import_batch_hands (user_id, import_batch_id, outcome);

CREATE FUNCTION public.set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER profiles_set_updated_at
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER poker_accounts_set_updated_at
  BEFORE UPDATE ON public.poker_accounts
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER privacy_consents_set_updated_at
  BEFORE UPDATE ON public.privacy_consents
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER import_batches_set_updated_at
  BEFORE UPDATE ON public.import_batches
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER sessions_set_updated_at
  BEFORE UPDATE ON public.sessions
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER hands_set_updated_at
  BEFORE UPDATE ON public.hands
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

REVOKE ALL ON FUNCTION public.set_updated_at() FROM PUBLIC, anon, authenticated;

-- Table privileges are the first gate. anon receives nothing; authenticated
-- receives only row-level DML, with ownership enforced again by RLS below.
REVOKE ALL ON TABLE
  public.profiles,
  public.poker_accounts,
  public.privacy_consents,
  public.import_batches,
  public.sessions,
  public.hands,
  public.import_batch_hands
FROM PUBLIC, anon, authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  public.profiles,
  public.poker_accounts
TO authenticated;

-- Consent is append-only and imported results are immutable from the browser.
-- Users may still delete their own cloud library; cascades remove dependent rows.
GRANT SELECT, INSERT ON TABLE public.privacy_consents TO authenticated;
GRANT SELECT, INSERT, DELETE ON TABLE
  public.import_batches,
  public.sessions,
  public.hands,
  public.import_batch_hands
TO authenticated;

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.profiles FORCE ROW LEVEL SECURITY;
ALTER TABLE public.poker_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.poker_accounts FORCE ROW LEVEL SECURITY;
ALTER TABLE public.privacy_consents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.privacy_consents FORCE ROW LEVEL SECURITY;
ALTER TABLE public.import_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.import_batches FORCE ROW LEVEL SECURITY;
ALTER TABLE public.sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sessions FORCE ROW LEVEL SECURITY;
ALTER TABLE public.hands ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hands FORCE ROW LEVEL SECURITY;
ALTER TABLE public.import_batch_hands ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.import_batch_hands FORCE ROW LEVEL SECURITY;

CREATE POLICY profiles_owner_all
  ON public.profiles
  FOR ALL
  TO authenticated
  USING ((SELECT auth.uid()) IS NOT NULL AND user_id = (SELECT auth.uid()))
  WITH CHECK ((SELECT auth.uid()) IS NOT NULL AND user_id = (SELECT auth.uid()));

CREATE POLICY poker_accounts_owner_all
  ON public.poker_accounts
  FOR ALL
  TO authenticated
  USING ((SELECT auth.uid()) IS NOT NULL AND user_id = (SELECT auth.uid()))
  WITH CHECK ((SELECT auth.uid()) IS NOT NULL AND user_id = (SELECT auth.uid()));

CREATE POLICY privacy_consents_owner_all
  ON public.privacy_consents
  FOR ALL
  TO authenticated
  USING ((SELECT auth.uid()) IS NOT NULL AND user_id = (SELECT auth.uid()))
  WITH CHECK ((SELECT auth.uid()) IS NOT NULL AND user_id = (SELECT auth.uid()));

CREATE POLICY import_batches_owner_all
  ON public.import_batches
  FOR ALL
  TO authenticated
  USING ((SELECT auth.uid()) IS NOT NULL AND user_id = (SELECT auth.uid()))
  WITH CHECK ((SELECT auth.uid()) IS NOT NULL AND user_id = (SELECT auth.uid()));

CREATE POLICY sessions_owner_all
  ON public.sessions
  FOR ALL
  TO authenticated
  USING ((SELECT auth.uid()) IS NOT NULL AND user_id = (SELECT auth.uid()))
  WITH CHECK ((SELECT auth.uid()) IS NOT NULL AND user_id = (SELECT auth.uid()));

CREATE POLICY hands_owner_all
  ON public.hands
  FOR ALL
  TO authenticated
  USING ((SELECT auth.uid()) IS NOT NULL AND user_id = (SELECT auth.uid()))
  WITH CHECK ((SELECT auth.uid()) IS NOT NULL AND user_id = (SELECT auth.uid()));

CREATE POLICY import_batch_hands_owner_all
  ON public.import_batch_hands
  FOR ALL
  TO authenticated
  USING ((SELECT auth.uid()) IS NOT NULL AND user_id = (SELECT auth.uid()))
  WITH CHECK ((SELECT auth.uid()) IS NOT NULL AND user_id = (SELECT auth.uid()));

COMMIT;
