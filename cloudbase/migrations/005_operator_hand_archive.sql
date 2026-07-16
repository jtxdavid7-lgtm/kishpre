BEGIN;

-- Operator archive for users who explicitly opt in to contributing a copy of
-- imported GG hand histories. This corpus is deliberately separate from each
-- user's private hand library. Browser roles cannot read or write these tables
-- directly; the narrowly-scoped SECURITY DEFINER functions below are the only
-- client-facing entry points.

CREATE TABLE public.operator_hand_corpus (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  content_sha256 text NOT NULL,
  external_hand_id text NOT NULL,
  raw_text text NOT NULL,
  raw_bytes integer NOT NULL,
  validation_status text NOT NULL DEFAULT 'pending',
  validated_at timestamptz,
  validation_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT operator_corpus_sha_unique UNIQUE (content_sha256),
  CONSTRAINT operator_corpus_identity_unique
    UNIQUE (id, content_sha256, external_hand_id, raw_bytes),
  CONSTRAINT operator_corpus_sha_format CHECK (
    content_sha256 ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT operator_corpus_external_id_format CHECK (
    external_hand_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$'
  ),
  CONSTRAINT operator_corpus_raw_size CHECK (
    raw_bytes = octet_length(raw_text)
    AND raw_bytes BETWEEN 1 AND 262144
  ),
  CONSTRAINT operator_corpus_raw_header CHECK (
    left(raw_text, 12) = 'Poker Hand #'
    AND left(raw_text, 13 + char_length(external_hand_id))
      = 'Poker Hand #' || external_hand_id || ':'
  ),
  CONSTRAINT operator_corpus_sha_matches_raw CHECK (
    content_sha256 = encode(sha256(convert_to(raw_text, 'UTF8')), 'hex')
  ),
  CONSTRAINT operator_corpus_validation_status CHECK (
    validation_status IN ('pending', 'valid', 'invalid')
  ),
  CONSTRAINT operator_corpus_validation_state CHECK (
    (validation_status = 'pending' AND validated_at IS NULL AND validation_error IS NULL)
    OR (validation_status = 'valid' AND validated_at IS NOT NULL AND validation_error IS NULL)
    OR (
      validation_status = 'invalid'
      AND validated_at IS NOT NULL
      AND char_length(COALESCE(validation_error, '')) BETWEEN 1 AND 1000
    )
  )
);

CREATE TABLE public.operator_hand_archive_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contributor_id text NOT NULL,
  client_batch_id uuid NOT NULL,
  consent_token uuid NOT NULL,
  consent_version text NOT NULL,
  consent_evidence jsonb NOT NULL,
  delete_secret_sha256 text NOT NULL,
  request_sha256 text NOT NULL,
  is_anonymous boolean NOT NULL,
  hand_count integer NOT NULL,
  payload_bytes bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT operator_batches_owner_client_unique
    UNIQUE (contributor_id, client_batch_id),
  CONSTRAINT operator_batches_owner_id_unique
    UNIQUE (contributor_id, id),
  CONSTRAINT operator_batches_contributor_present CHECK (
    char_length(btrim(contributor_id)) BETWEEN 1 AND 256
  ),
  CONSTRAINT operator_batches_consent_version_format CHECK (
    consent_version ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$'
  ),
  CONSTRAINT operator_batches_consent_evidence_object CHECK (
    jsonb_typeof(consent_evidence) = 'object'
  ),
  CONSTRAINT operator_batches_delete_secret_sha_format CHECK (
    delete_secret_sha256 ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT operator_batches_request_sha_format CHECK (
    request_sha256 ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT operator_batches_counts_valid CHECK (
    hand_count BETWEEN 1 AND 500
    AND payload_bytes BETWEEN 1 AND 768000
  )
);

-- Quota accounting is kept separately from removable archive data. Otherwise
-- a caller could withdraw and immediately re-upload to reset the daily limit.
-- Only a one-way contributor hash is retained here.
CREATE TABLE public.operator_hand_archive_daily_usage (
  contributor_sha256 text NOT NULL,
  usage_day date NOT NULL,
  hand_count integer NOT NULL,
  payload_bytes bigint NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (contributor_sha256, usage_day),
  CONSTRAINT operator_daily_usage_contributor_sha_format CHECK (
    contributor_sha256 ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT operator_daily_usage_counts_valid CHECK (
    hand_count BETWEEN 0 AND 100000
    AND payload_bytes BETWEEN 0 AND 536870912
  )
);

-- A separate environment-wide circuit breaker bounds storage/cost even when
-- an abusive anonymous client repeatedly resets its local identity. This is
-- intentionally conservative for the initial public rollout and can be raised
-- in a later migration once real traffic is understood.
CREATE TABLE public.operator_hand_archive_environment_usage (
  usage_day date PRIMARY KEY,
  hand_count integer NOT NULL,
  payload_bytes bigint NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT operator_environment_usage_counts_valid CHECK (
    hand_count BETWEEN 0 AND 250000
    AND payload_bytes BETWEEN 0 AND 1073741824
  )
);

-- A server-issued consent generation closes the race between a delayed upload
-- and a delete request. Ingests hold shared scope locks and deletes hold
-- exclusive locks; removing the token makes every late request fail closed.
CREATE TABLE public.operator_hand_archive_consents (
  consent_token uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contributor_id text NOT NULL,
  delete_secret_sha256 text NOT NULL,
  consent_version text NOT NULL,
  consent_evidence jsonb NOT NULL,
  accepted_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  CONSTRAINT operator_consents_contributor_present CHECK (
    char_length(btrim(contributor_id)) BETWEEN 1 AND 256
  ),
  CONSTRAINT operator_consents_delete_secret_sha_format CHECK (
    delete_secret_sha256 ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT operator_consents_version_format CHECK (
    consent_version ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$'
  ),
  CONSTRAINT operator_consents_evidence_object CHECK (
    jsonb_typeof(consent_evidence) = 'object'
  ),
  CONSTRAINT operator_consents_revoked_after_accept CHECK (
    revoked_at IS NULL OR revoked_at >= accepted_at
  )
);

CREATE TABLE public.operator_hand_archive_batch_hands (
  contributor_id text NOT NULL,
  batch_id uuid NOT NULL,
  corpus_hand_id uuid NOT NULL,
  external_hand_id text NOT NULL,
  content_sha256 text NOT NULL,
  raw_bytes integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (batch_id, corpus_hand_id),
  CONSTRAINT operator_batch_hands_batch_external_unique
    UNIQUE (batch_id, external_hand_id),
  CONSTRAINT operator_batch_hands_batch_owner_fk
    FOREIGN KEY (contributor_id, batch_id)
    REFERENCES public.operator_hand_archive_batches (contributor_id, id)
    ON DELETE CASCADE,
  CONSTRAINT operator_batch_hands_corpus_identity_fk
    FOREIGN KEY (
      corpus_hand_id,
      content_sha256,
      external_hand_id,
      raw_bytes
    )
    REFERENCES public.operator_hand_corpus (
      id,
      content_sha256,
      external_hand_id,
      raw_bytes
    )
    ON DELETE RESTRICT,
  CONSTRAINT operator_batch_hands_sha_format CHECK (
    content_sha256 ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT operator_batch_hands_external_id_format CHECK (
    external_hand_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$'
  ),
  CONSTRAINT operator_batch_hands_raw_size CHECK (
    raw_bytes BETWEEN 1 AND 262144
  )
);

CREATE INDEX operator_batches_owner_created_idx
  ON public.operator_hand_archive_batches (contributor_id, created_at DESC);
CREATE INDEX operator_batches_delete_secret_idx
  ON public.operator_hand_archive_batches (delete_secret_sha256, created_at DESC);
CREATE INDEX operator_batches_owner_day_quota_idx
  ON public.operator_hand_archive_batches (
    contributor_id,
    created_at,
    hand_count,
    payload_bytes
  );
CREATE INDEX operator_daily_usage_day_idx
  ON public.operator_hand_archive_daily_usage (usage_day);
CREATE INDEX operator_consents_owner_active_idx
  ON public.operator_hand_archive_consents (contributor_id, revoked_at);
CREATE INDEX operator_consents_secret_active_idx
  ON public.operator_hand_archive_consents (delete_secret_sha256, revoked_at);
CREATE INDEX operator_batch_hands_corpus_idx
  ON public.operator_hand_archive_batch_hands (corpus_hand_id);
CREATE INDEX operator_batch_hands_owner_idx
  ON public.operator_hand_archive_batch_hands (contributor_id, batch_id);
CREATE INDEX operator_corpus_validation_idx
  ON public.operator_hand_corpus (validation_status, created_at);

REVOKE ALL ON TABLE
  public.operator_hand_corpus,
  public.operator_hand_archive_batches,
  public.operator_hand_archive_daily_usage,
  public.operator_hand_archive_environment_usage,
  public.operator_hand_archive_consents,
  public.operator_hand_archive_batch_hands
FROM PUBLIC, anon, authenticated;

GRANT ALL ON TABLE
  public.operator_hand_corpus,
  public.operator_hand_archive_batches,
  public.operator_hand_archive_daily_usage,
  public.operator_hand_archive_environment_usage,
  public.operator_hand_archive_consents,
  public.operator_hand_archive_batch_hands
TO service_role;

ALTER TABLE public.operator_hand_corpus ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.operator_hand_corpus FORCE ROW LEVEL SECURITY;
ALTER TABLE public.operator_hand_archive_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.operator_hand_archive_batches FORCE ROW LEVEL SECURITY;
ALTER TABLE public.operator_hand_archive_daily_usage ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.operator_hand_archive_daily_usage FORCE ROW LEVEL SECURITY;
ALTER TABLE public.operator_hand_archive_environment_usage ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.operator_hand_archive_environment_usage FORCE ROW LEVEL SECURITY;
ALTER TABLE public.operator_hand_archive_consents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.operator_hand_archive_consents FORCE ROW LEVEL SECURITY;
ALTER TABLE public.operator_hand_archive_batch_hands ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.operator_hand_archive_batch_hands FORCE ROW LEVEL SECURITY;

-- Intentionally create no RLS policies. Even a contributor cannot enumerate
-- the operator corpus, batches, or links. A migration/service role with
-- BYPASSRLS must own the SECURITY DEFINER functions for their writes to work.

CREATE FUNCTION public.create_operator_archive_consent(
  p_delete_secret text,
  p_consent_version text,
  p_consent_evidence jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = off
AS $$
DECLARE
  caller_id text := auth.uid();
  jwt_claims_text text := current_setting('request.jwt.claims', true);
  jwt_claims jsonb := '{}'::jsonb;
  jwt_role_setting text := NULLIF(current_setting('request.jwt.claim.role', true), '');
  jwt_role text;
  delete_secret_sha256_value text;
  issued_token uuid;
  issued_at timestamptz;
BEGIN
  IF jwt_claims_text IS NOT NULL AND btrim(jwt_claims_text) <> '' THEN
    BEGIN
      jwt_claims := jwt_claims_text::jsonb;
    EXCEPTION WHEN others THEN
      RAISE EXCEPTION USING
        ERRCODE = '42501',
        MESSAGE = 'The JWT claims supplied by the gateway are invalid.';
    END;
  END IF;

  jwt_role := NULLIF(jwt_claims ->> 'role', '');
  IF jwt_role IS NULL THEN
    jwt_role := jwt_role_setting;
  ELSIF jwt_role_setting IS NOT NULL AND jwt_role_setting <> jwt_role THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'Conflicting JWT role claims were supplied by the gateway.';
  END IF;

  IF jwt_role IS NULL OR jwt_role NOT IN ('anon', 'authenticated') THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'Only anon or authenticated JWT callers may create archive consent.';
  END IF;

  IF caller_id IS NULL OR btrim(caller_id) = '' THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'A non-empty authenticated or anonymous user id is required.';
  END IF;

  IF p_delete_secret IS NULL OR p_delete_secret !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'delete_secret must be 64 lowercase hexadecimal characters.';
  END IF;

  IF p_consent_version IS NULL
    OR p_consent_version !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$' THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'consent_version has an invalid format.';
  END IF;

  IF p_consent_evidence IS NULL
    OR jsonb_typeof(p_consent_evidence) <> 'object'
    OR p_consent_evidence -> 'granted' IS DISTINCT FROM 'true'::jsonb
    OR COALESCE(p_consent_evidence ->> 'choice', '') <> 'explicit_accept' THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'Explicit granted consent evidence is required.';
  END IF;

  IF octet_length(p_consent_evidence::text) > 2048 THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'consent_evidence exceeds 2 KiB.';
  END IF;

  delete_secret_sha256_value := encode(
    sha256(convert_to(p_delete_secret, 'UTF8')),
    'hex'
  );

  -- Consent issuance is exclusive for both scopes. It waits for older uploads,
  -- revokes their tokens, and gives the new explicit choice a fresh generation.
  PERFORM pg_advisory_xact_lock(hashtextextended(caller_id, 1263487561));
  PERFORM pg_advisory_xact_lock(
    hashtextextended(delete_secret_sha256_value, 772941823)
  );

  DELETE FROM public.operator_hand_archive_consents AS consent
  WHERE consent.contributor_id = caller_id
    OR consent.delete_secret_sha256 = delete_secret_sha256_value;

  INSERT INTO public.operator_hand_archive_consents (
    contributor_id,
    delete_secret_sha256,
    consent_version,
    consent_evidence
  )
  VALUES (
    caller_id,
    delete_secret_sha256_value,
    p_consent_version,
    p_consent_evidence
  )
  RETURNING consent_token, accepted_at INTO issued_token, issued_at;

  RETURN jsonb_build_object(
    'consent_token', issued_token,
    'accepted_at', issued_at
  );
END;
$$;

CREATE FUNCTION public.revoke_operator_archive_consent(
  p_consent_token uuid,
  p_delete_secret text
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = off
AS $$
DECLARE
  caller_id text := auth.uid();
  jwt_claims_text text := current_setting('request.jwt.claims', true);
  jwt_claims jsonb := '{}'::jsonb;
  jwt_role_setting text := NULLIF(current_setting('request.jwt.claim.role', true), '');
  jwt_role text;
  delete_secret_sha256_value text;
  revoked_count bigint;
BEGIN
  IF jwt_claims_text IS NOT NULL AND btrim(jwt_claims_text) <> '' THEN
    BEGIN
      jwt_claims := jwt_claims_text::jsonb;
    EXCEPTION WHEN others THEN
      RAISE EXCEPTION USING
        ERRCODE = '42501',
        MESSAGE = 'The JWT claims supplied by the gateway are invalid.';
    END;
  END IF;

  jwt_role := NULLIF(jwt_claims ->> 'role', '');
  IF jwt_role IS NULL THEN
    jwt_role := jwt_role_setting;
  ELSIF jwt_role_setting IS NOT NULL AND jwt_role_setting <> jwt_role THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'Conflicting JWT role claims were supplied by the gateway.';
  END IF;

  IF jwt_role IS NULL OR jwt_role NOT IN ('anon', 'authenticated') THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'Only anon or authenticated JWT callers may revoke archive consent.';
  END IF;

  IF caller_id IS NULL OR btrim(caller_id) = '' THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'A non-empty authenticated or anonymous user id is required.';
  END IF;

  IF p_consent_token IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'consent_token is required.';
  END IF;

  IF p_delete_secret IS NULL OR p_delete_secret !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'delete_secret must be 64 lowercase hexadecimal characters.';
  END IF;

  delete_secret_sha256_value := encode(
    sha256(convert_to(p_delete_secret, 'UTF8')),
    'hex'
  );

  -- The device lock waits for already-running batches. Once this delete
  -- commits, every later request carrying the old token is rejected.
  PERFORM pg_advisory_xact_lock(
    hashtextextended(delete_secret_sha256_value, 772941823)
  );

  DELETE FROM public.operator_hand_archive_consents AS consent
  WHERE consent.consent_token = p_consent_token
    AND consent.delete_secret_sha256 = delete_secret_sha256_value;
  GET DIAGNOSTICS revoked_count = ROW_COUNT;

  RETURN jsonb_build_object('revoked', revoked_count > 0);
END;
$$;

CREATE FUNCTION public.ingest_operator_hand_archive(
  p_client_batch_id uuid,
  p_consent_token uuid,
  p_delete_secret text,
  p_consent_version text,
  p_consent_evidence jsonb,
  p_hands jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = off
AS $$
DECLARE
  caller_id text := auth.uid();
  jwt_claims_text text := current_setting('request.jwt.claims', true);
  jwt_claims jsonb := '{}'::jsonb;
  jwt_role_setting text := NULLIF(current_setting('request.jwt.claim.role', true), '');
  jwt_role text;
  caller_is_anonymous boolean;
  hand_item jsonb;
  item_external_hand_id text;
  item_content_sha256 text;
  item_raw_text text;
  item_raw_bytes integer;
  supplied_hand_count integer;
  supplied_payload_bytes integer;
  delete_secret_sha256_value text;
  contributor_sha256_value text;
  request_sha256_value text;
  evidence_accepted_at timestamptz;
  registered_consent public.operator_hand_archive_consents%ROWTYPE;
  existing_batch public.operator_hand_archive_batches%ROWTYPE;
  archive_batch_id uuid;
  corpus_hand_id uuid;
  quota_day date;
  quota_applied boolean;
  environment_quota_applied boolean;
BEGIN
  -- SECURITY DEFINER changes current_user, so authorization must come from
  -- trusted JWT request settings plus auth.uid(), never from current_user.
  IF jwt_claims_text IS NOT NULL AND btrim(jwt_claims_text) <> '' THEN
    BEGIN
      jwt_claims := jwt_claims_text::jsonb;
    EXCEPTION WHEN others THEN
      RAISE EXCEPTION USING
        ERRCODE = '42501',
        MESSAGE = 'The JWT claims supplied by the gateway are invalid.';
    END;
  END IF;

  jwt_role := NULLIF(jwt_claims ->> 'role', '');
  IF jwt_role IS NULL THEN
    jwt_role := jwt_role_setting;
  ELSIF jwt_role_setting IS NOT NULL AND jwt_role_setting <> jwt_role THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'Conflicting JWT role claims were supplied by the gateway.';
  END IF;

  IF jwt_role IS NULL OR jwt_role NOT IN ('anon', 'authenticated') THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'Only anon or authenticated JWT callers may ingest hand histories.';
  END IF;

  IF caller_id IS NULL OR btrim(caller_id) = '' THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'A non-empty authenticated or anonymous user id is required.';
  END IF;

  IF p_client_batch_id IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'client_batch_id is required.';
  END IF;

  IF p_consent_token IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'consent_token is required.';
  END IF;

  IF p_delete_secret IS NULL OR p_delete_secret !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'delete_secret must be 64 lowercase hexadecimal characters.';
  END IF;

  delete_secret_sha256_value := encode(
    sha256(convert_to(p_delete_secret, 'UTF8')),
    'hex'
  );
  contributor_sha256_value := encode(
    sha256(convert_to(caller_id, 'UTF8')),
    'hex'
  );

  IF p_consent_version IS NULL
    OR p_consent_version !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$' THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'consent_version has an invalid format.';
  END IF;

  IF p_consent_evidence IS NULL
    OR jsonb_typeof(p_consent_evidence) <> 'object'
    OR p_consent_evidence -> 'granted' IS DISTINCT FROM 'true'::jsonb
    OR COALESCE(p_consent_evidence ->> 'choice', '')
      NOT IN ('explicit_accept', 'stored_default')
    OR jsonb_typeof(p_consent_evidence -> 'acceptedAt') IS DISTINCT FROM 'string'
    OR COALESCE(p_consent_evidence ->> 'acceptedAt', '')
      !~ '^20[0-9]{2}-[0-9]{2}-[0-9]{2}T' THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'Valid granted consent evidence is required.';
  END IF;

  IF octet_length(p_consent_evidence::text) > 2048 THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'consent_evidence exceeds 2 KiB.';
  END IF;

  BEGIN
    evidence_accepted_at := (p_consent_evidence ->> 'acceptedAt')::timestamptz;
  EXCEPTION WHEN others THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'consent_evidence acceptedAt is not a valid timestamp.';
  END;

  IF p_hands IS NULL OR jsonb_typeof(p_hands) <> 'array' THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'hands must be a JSON array.';
  END IF;

  supplied_hand_count := jsonb_array_length(p_hands);
  IF supplied_hand_count < 1 OR supplied_hand_count > 500 THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'Each request must contain between 1 and 500 hands.';
  END IF;

  supplied_payload_bytes := octet_length(
    jsonb_build_object(
      'client_batch_id', p_client_batch_id,
      'consent_token', p_consent_token,
      'delete_secret', p_delete_secret,
      'consent_version', p_consent_version,
      'consent_evidence', p_consent_evidence,
      'hands', p_hands
    )::text
  );
  IF supplied_payload_bytes > 768000 THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'The request payload exceeds 750 KiB.';
  END IF;

  -- Validate the entire request before taking a lock or mutating any table.
  FOR hand_item IN
    SELECT value FROM jsonb_array_elements(p_hands)
  LOOP
    IF jsonb_typeof(hand_item) IS DISTINCT FROM 'object'
      OR jsonb_typeof(hand_item -> 'external_hand_id') IS DISTINCT FROM 'string'
      OR jsonb_typeof(hand_item -> 'content_sha256') IS DISTINCT FROM 'string'
      OR jsonb_typeof(hand_item -> 'raw_text') IS DISTINCT FROM 'string' THEN
      RAISE EXCEPTION USING
        ERRCODE = '22023',
        MESSAGE = 'Each hand must contain string external_hand_id, content_sha256, and raw_text fields.';
    END IF;

    item_external_hand_id := hand_item ->> 'external_hand_id';
    item_content_sha256 := hand_item ->> 'content_sha256';
    item_raw_text := hand_item ->> 'raw_text';
    item_raw_bytes := octet_length(item_raw_text);

    IF item_external_hand_id !~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$' THEN
      RAISE EXCEPTION USING
        ERRCODE = '22023',
        MESSAGE = 'A hand has an invalid external_hand_id.';
    END IF;

    IF item_content_sha256 !~ '^[0-9a-f]{64}$' THEN
      RAISE EXCEPTION USING
        ERRCODE = '22023',
        MESSAGE = 'A hand has an invalid content_sha256.';
    END IF;

    IF item_raw_bytes < 1 OR item_raw_bytes > 262144 THEN
      RAISE EXCEPTION USING
        ERRCODE = '22023',
        MESSAGE = 'A hand raw_text must be between 1 byte and 256 KiB.';
    END IF;

    IF left(item_raw_text, 12) <> 'Poker Hand #' THEN
      RAISE EXCEPTION USING
        ERRCODE = '22023',
        MESSAGE = 'A hand raw_text does not start with Poker Hand #.';
    END IF;

    IF left(item_raw_text, 13 + char_length(item_external_hand_id))
      <> 'Poker Hand #' || item_external_hand_id || ':' THEN
      RAISE EXCEPTION USING
        ERRCODE = '22023',
        MESSAGE = 'external_hand_id does not match the raw hand header.';
    END IF;

    IF encode(sha256(convert_to(item_raw_text, 'UTF8')), 'hex')
      <> item_content_sha256 THEN
      RAISE EXCEPTION USING
        ERRCODE = '22023',
        MESSAGE = 'content_sha256 does not match raw_text.';
    END IF;

  END LOOP;

  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(p_hands) AS items(value)
    GROUP BY value ->> 'content_sha256'
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'A batch cannot contain duplicate content_sha256 values.';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(p_hands) AS items(value)
    GROUP BY value ->> 'external_hand_id'
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'A batch cannot contain duplicate external_hand_id values.';
  END IF;

  request_sha256_value := encode(
    sha256(
      convert_to(
        jsonb_build_object(
          'consent_version', p_consent_version,
          'consent_token', p_consent_token,
          'consent_evidence', p_consent_evidence,
          'delete_secret_sha256', delete_secret_sha256_value,
          'hands', p_hands
        )::text,
        'UTF8'
      )
    ),
    'hex'
  );

  caller_is_anonymous := (
    jwt_role = 'anon'
    OR lower(COALESCE(jwt_claims ->> 'scope', '')) = 'anonymous'
    OR lower(COALESCE(jwt_claims ->> 'is_anonymous', 'false')) IN ('true', '1')
    OR lower(COALESCE(jwt_claims ->> 'anonymous', 'false')) IN ('true', '1')
  );

  -- Concurrent batches share the contributor and device scope locks. Consent
  -- issuance and withdrawal take the corresponding exclusive locks, so an old
  -- token cannot write after a delete or a newly issued consent generation.
  PERFORM pg_advisory_xact_lock_shared(hashtextextended(caller_id, 1263487561));
  PERFORM pg_advisory_xact_lock_shared(
    hashtextextended(delete_secret_sha256_value, 772941823)
  );
  -- Retries of the same client batch serialize without blocking unrelated
  -- batches from this contributor.
  PERFORM pg_advisory_xact_lock(
    hashtextextended(caller_id || ':' || p_client_batch_id::text, 934761221)
  );

  SELECT consent.*
  INTO registered_consent
  FROM public.operator_hand_archive_consents AS consent
  WHERE consent.consent_token = p_consent_token
    AND consent.contributor_id = caller_id
    AND consent.delete_secret_sha256 = delete_secret_sha256_value
    AND consent.consent_version = p_consent_version
    AND consent.revoked_at IS NULL;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'The archive consent token is missing, mismatched, or revoked.';
  END IF;

  IF evidence_accepted_at IS DISTINCT FROM registered_consent.accepted_at THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'The archive consent evidence does not match the server-issued consent time.';
  END IF;

  SELECT batch.*
  INTO existing_batch
  FROM public.operator_hand_archive_batches AS batch
  WHERE batch.contributor_id = caller_id
    AND batch.client_batch_id = p_client_batch_id;

  IF FOUND THEN
    IF existing_batch.request_sha256 <> request_sha256_value THEN
      RAISE EXCEPTION USING
        ERRCODE = '22023',
        MESSAGE = 'client_batch_id was already used for a different request.';
    END IF;

    RETURN jsonb_build_object(
      'client_batch_id', existing_batch.client_batch_id,
      'accepted_count', existing_batch.hand_count,
      'accepted_bytes', existing_batch.payload_bytes,
      'idempotent', true
    );
  END IF;

  quota_day := (now() AT TIME ZONE 'UTC')::date;

  -- Opportunistically clear expired anti-abuse counters. Production should
  -- also schedule this same predicate so quiet periods do not delay cleanup.
  -- Rows contain no raw hands or UID, only a one-way contributor hash and
  -- daily aggregate counts.
  DELETE FROM public.operator_hand_archive_daily_usage AS expired_usage
  WHERE expired_usage.usage_day < quota_day - 90;

  DELETE FROM public.operator_hand_archive_environment_usage AS expired_usage
  WHERE expired_usage.usage_day < quota_day - 90;

  INSERT INTO public.operator_hand_archive_batches (
    contributor_id,
    client_batch_id,
    consent_token,
    consent_version,
    consent_evidence,
    delete_secret_sha256,
    request_sha256,
    is_anonymous,
    hand_count,
    payload_bytes
  )
  VALUES (
    caller_id,
    p_client_batch_id,
    p_consent_token,
    p_consent_version,
    p_consent_evidence,
    delete_secret_sha256_value,
    request_sha256_value,
    caller_is_anonymous,
    supplied_hand_count,
    supplied_payload_bytes
  )
  RETURNING id INTO archive_batch_id;

  FOR hand_item IN
    SELECT value FROM jsonb_array_elements(p_hands)
  LOOP
    item_external_hand_id := hand_item ->> 'external_hand_id';
    item_content_sha256 := hand_item ->> 'content_sha256';
    item_raw_text := hand_item ->> 'raw_text';
    item_raw_bytes := octet_length(item_raw_text);
    corpus_hand_id := NULL;

    -- Browser submissions always enter quarantine as pending. Downstream
    -- operator analytics must filter for validation_status = 'valid' after a
    -- trusted server-side GG parser has checked the complete hand structure.
    INSERT INTO public.operator_hand_corpus (
      content_sha256,
      external_hand_id,
      raw_text,
      raw_bytes
    )
    VALUES (
      item_content_sha256,
      item_external_hand_id,
      item_raw_text,
      item_raw_bytes
    )
    ON CONFLICT (content_sha256) DO NOTHING
    RETURNING id INTO corpus_hand_id;

    IF corpus_hand_id IS NULL THEN
      SELECT corpus.id
      INTO STRICT corpus_hand_id
      FROM public.operator_hand_corpus AS corpus
      WHERE corpus.content_sha256 = item_content_sha256;
    END IF;

    INSERT INTO public.operator_hand_archive_batch_hands (
      contributor_id,
      batch_id,
      corpus_hand_id,
      external_hand_id,
      content_sha256,
      raw_bytes
    )
    VALUES (
      caller_id,
      archive_batch_id,
      corpus_hand_id,
      item_external_hand_id,
      item_content_sha256,
      item_raw_bytes
    );
  END LOOP;

  -- Apply quota at the end so concurrent batch transactions only serialize
  -- for this short atomic counter update, not for all corpus inserts. If the
  -- conditional upsert rejects the increment, this whole transaction rolls
  -- back and no partial archive remains.
  quota_applied := false;
  INSERT INTO public.operator_hand_archive_daily_usage (
    contributor_sha256,
    usage_day,
    hand_count,
    payload_bytes,
    updated_at
  )
  VALUES (
    contributor_sha256_value,
    quota_day,
    supplied_hand_count,
    supplied_payload_bytes,
    now()
  )
  ON CONFLICT (contributor_sha256, usage_day) DO UPDATE
  SET hand_count = public.operator_hand_archive_daily_usage.hand_count
      + EXCLUDED.hand_count,
      payload_bytes = public.operator_hand_archive_daily_usage.payload_bytes
      + EXCLUDED.payload_bytes,
      updated_at = now()
  WHERE public.operator_hand_archive_daily_usage.hand_count
          + EXCLUDED.hand_count <= 100000
    AND public.operator_hand_archive_daily_usage.payload_bytes
          + EXCLUDED.payload_bytes <= 536870912
  RETURNING true INTO quota_applied;

  IF NOT COALESCE(quota_applied, false) THEN
    RAISE EXCEPTION USING
      ERRCODE = '54000',
      MESSAGE = 'The daily contributor quota would be exceeded.';
  END IF;

  environment_quota_applied := false;
  INSERT INTO public.operator_hand_archive_environment_usage (
    usage_day,
    hand_count,
    payload_bytes,
    updated_at
  )
  VALUES (
    quota_day,
    supplied_hand_count,
    supplied_payload_bytes,
    now()
  )
  ON CONFLICT (usage_day) DO UPDATE
  SET hand_count = public.operator_hand_archive_environment_usage.hand_count
      + EXCLUDED.hand_count,
      payload_bytes = public.operator_hand_archive_environment_usage.payload_bytes
      + EXCLUDED.payload_bytes,
      updated_at = now()
  WHERE public.operator_hand_archive_environment_usage.hand_count
          + EXCLUDED.hand_count <= 250000
    AND public.operator_hand_archive_environment_usage.payload_bytes
          + EXCLUDED.payload_bytes <= 1073741824
  RETURNING true INTO environment_quota_applied;

  IF NOT COALESCE(environment_quota_applied, false) THEN
    RAISE EXCEPTION USING
      ERRCODE = '54000',
      MESSAGE = 'The daily environment archive quota would be exceeded.';
  END IF;

  -- Do not reveal whether any canonical rows were already contributed by
  -- another caller. Only this caller's accepted request counts are returned.
  RETURN jsonb_build_object(
    'client_batch_id', p_client_batch_id,
    'accepted_count', supplied_hand_count,
    'accepted_bytes', supplied_payload_bytes,
    'idempotent', false
  );
END;
$$;

-- Internal deletion primitive. CloudBase currently exposes every public RPC
-- regardless of GRANT EXECUTE, so this helper MUST remain SECURITY INVOKER and
-- explicitly require the service_role context supplied by the validated
-- SECURITY DEFINER wrappers below. A direct browser call therefore fails
-- before touching any table. The global deletion lock serializes cleanup for
-- shared canonical rows, and each batch contributes at most 500 UUIDs so
-- withdrawal has bounded working memory.
CREATE FUNCTION public.delete_operator_hand_archive_scope(
  p_contributor_id text,
  p_delete_secret_sha256 text
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = pg_catalog, public
SET row_security = off
AS $$
DECLARE
  target_batch_id uuid;
  released_corpus_ids uuid[];
  batch_link_count bigint;
  batch_delete_count bigint;
  deleted_link_count bigint := 0;
  deleted_batch_count bigint := 0;
BEGIN
  IF current_user <> 'service_role' THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'This internal archive deletion helper is not client callable.';
  END IF;

  IF (p_contributor_id IS NULL) = (p_delete_secret_sha256 IS NULL) THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'Exactly one archive deletion scope is required.';
  END IF;

  IF p_contributor_id IS NOT NULL
    AND char_length(btrim(p_contributor_id)) NOT BETWEEN 1 AND 256 THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'The contributor deletion scope is invalid.';
  END IF;

  IF p_delete_secret_sha256 IS NOT NULL
    AND p_delete_secret_sha256 !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'The secret deletion scope is invalid.';
  END IF;

  -- Serialize all withdrawals so two contributors removing the final links
  -- to the same canonical hand cannot both leave it orphaned.
  PERFORM pg_advisory_xact_lock(1263487561, 1);

  -- Removing the server-issued consent generation closes the delayed-upload
  -- race. Older RPCs wait on the scope lock and then fail token validation.
  DELETE FROM public.operator_hand_archive_consents AS consent
  WHERE (
    p_contributor_id IS NOT NULL
    AND consent.contributor_id = p_contributor_id
  ) OR (
    p_delete_secret_sha256 IS NOT NULL
    AND consent.delete_secret_sha256 = p_delete_secret_sha256
  );

  FOR target_batch_id IN
    SELECT batch.id
    FROM public.operator_hand_archive_batches AS batch
    WHERE (
      p_contributor_id IS NOT NULL
      AND batch.contributor_id = p_contributor_id
    ) OR (
      p_delete_secret_sha256 IS NOT NULL
      AND batch.delete_secret_sha256 = p_delete_secret_sha256
    )
    ORDER BY batch.created_at, batch.id
  LOOP
    released_corpus_ids := ARRAY[]::uuid[];
    batch_link_count := 0;

    WITH deleted_links AS (
      DELETE FROM public.operator_hand_archive_batch_hands AS link
      WHERE link.batch_id = target_batch_id
      RETURNING link.corpus_hand_id
    )
    SELECT
      COALESCE(array_agg(DISTINCT corpus_hand_id), ARRAY[]::uuid[]),
      count(*)
    INTO released_corpus_ids, batch_link_count
    FROM deleted_links;

    deleted_link_count := deleted_link_count + batch_link_count;

    DELETE FROM public.operator_hand_archive_batches AS batch
    WHERE batch.id = target_batch_id;
    GET DIAGNOSTICS batch_delete_count = ROW_COUNT;
    deleted_batch_count := deleted_batch_count + batch_delete_count;

    IF cardinality(released_corpus_ids) > 0 THEN
      DELETE FROM public.operator_hand_corpus AS corpus
      WHERE corpus.id = ANY (released_corpus_ids)
        AND NOT EXISTS (
          SELECT 1
          FROM public.operator_hand_archive_batch_hands AS remaining_link
          WHERE remaining_link.corpus_hand_id = corpus.id
        );
    END IF;
  END LOOP;

  -- Canonical cleanup counts are deliberately omitted: exposing them would
  -- reveal whether another contributor submitted any of the same hands.
  RETURN jsonb_build_object(
    'deleted_batches', deleted_batch_count,
    'deleted_hand_links', deleted_link_count,
    'canonical_cleanup_completed', true
  );
END;
$$;

CREATE FUNCTION public.delete_my_operator_hand_archive()
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = off
AS $$
DECLARE
  caller_id text := auth.uid();
  jwt_claims_text text := current_setting('request.jwt.claims', true);
  jwt_claims jsonb := '{}'::jsonb;
  jwt_role_setting text := NULLIF(current_setting('request.jwt.claim.role', true), '');
  jwt_role text;
BEGIN
  IF jwt_claims_text IS NOT NULL AND btrim(jwt_claims_text) <> '' THEN
    BEGIN
      jwt_claims := jwt_claims_text::jsonb;
    EXCEPTION WHEN others THEN
      RAISE EXCEPTION USING
        ERRCODE = '42501',
        MESSAGE = 'The JWT claims supplied by the gateway are invalid.';
    END;
  END IF;

  jwt_role := NULLIF(jwt_claims ->> 'role', '');
  IF jwt_role IS NULL THEN
    jwt_role := jwt_role_setting;
  ELSIF jwt_role_setting IS NOT NULL AND jwt_role_setting <> jwt_role THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'Conflicting JWT role claims were supplied by the gateway.';
  END IF;

  IF jwt_role IS NULL OR jwt_role NOT IN ('anon', 'authenticated') THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'Only anon or authenticated JWT callers may delete contributed hand histories.';
  END IF;

  IF caller_id IS NULL OR btrim(caller_id) = '' THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'A non-empty authenticated or anonymous user id is required.';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(caller_id, 1263487561));

  RETURN public.delete_operator_hand_archive_scope(caller_id, NULL);
END;
$$;

CREATE FUNCTION public.delete_operator_hand_archive_by_secret(
  p_delete_secret text
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = off
AS $$
DECLARE
  caller_id text := auth.uid();
  jwt_claims_text text := current_setting('request.jwt.claims', true);
  jwt_claims jsonb := '{}'::jsonb;
  jwt_role_setting text := NULLIF(current_setting('request.jwt.claim.role', true), '');
  jwt_role text;
  delete_secret_sha256_value text;
BEGIN
  IF jwt_claims_text IS NOT NULL AND btrim(jwt_claims_text) <> '' THEN
    BEGIN
      jwt_claims := jwt_claims_text::jsonb;
    EXCEPTION WHEN others THEN
      RAISE EXCEPTION USING
        ERRCODE = '42501',
        MESSAGE = 'The JWT claims supplied by the gateway are invalid.';
    END;
  END IF;

  jwt_role := NULLIF(jwt_claims ->> 'role', '');
  IF jwt_role IS NULL THEN
    jwt_role := jwt_role_setting;
  ELSIF jwt_role_setting IS NOT NULL AND jwt_role_setting <> jwt_role THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'Conflicting JWT role claims were supplied by the gateway.';
  END IF;

  IF jwt_role IS NULL OR jwt_role NOT IN ('anon', 'authenticated') THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'Only anon or authenticated JWT callers may delete contributed hand histories.';
  END IF;

  IF caller_id IS NULL OR btrim(caller_id) = '' THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'A non-empty authenticated or anonymous user id is required.';
  END IF;

  IF p_delete_secret IS NULL OR p_delete_secret !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'delete_secret must be 64 lowercase hexadecimal characters.';
  END IF;

  delete_secret_sha256_value := encode(
    sha256(convert_to(p_delete_secret, 'UTF8')),
    'hex'
  );

  PERFORM pg_advisory_xact_lock(
    hashtextextended(delete_secret_sha256_value, 772941823)
  );

  RETURN public.delete_operator_hand_archive_scope(NULL, delete_secret_sha256_value);
END;
$$;

REVOKE ALL ON FUNCTION public.create_operator_archive_consent(text, text, jsonb)
FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.revoke_operator_archive_consent(uuid, text)
FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.ingest_operator_hand_archive(uuid, uuid, text, text, jsonb, jsonb)
FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.delete_operator_hand_archive_scope(text, text)
FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.delete_my_operator_hand_archive()
FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.delete_operator_hand_archive_by_secret(text)
FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.create_operator_archive_consent(text, text, jsonb)
TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.revoke_operator_archive_consent(uuid, text)
TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ingest_operator_hand_archive(uuid, uuid, text, text, jsonb, jsonb)
TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.delete_my_operator_hand_archive()
TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.delete_operator_hand_archive_by_secret(text)
TO anon, authenticated;

-- FORCE RLS applies to an ordinary table/function owner. CloudBase's
-- service_role is the documented BYPASSRLS backend role; making it the
-- function owner is what lets these definer functions reach the policy-free
-- archive tables. A missing/renamed service_role therefore fails migration
-- loudly instead of leaving RPCs that only fail later at runtime. Transfer
-- ownership only after the migration role has finalized client privileges.
ALTER FUNCTION public.create_operator_archive_consent(text, text, jsonb)
  OWNER TO service_role;
ALTER FUNCTION public.revoke_operator_archive_consent(uuid, text)
  OWNER TO service_role;
ALTER FUNCTION public.ingest_operator_hand_archive(uuid, uuid, text, text, jsonb, jsonb)
  OWNER TO service_role;
ALTER FUNCTION public.delete_operator_hand_archive_scope(text, text)
  OWNER TO service_role;
ALTER FUNCTION public.delete_my_operator_hand_archive()
  OWNER TO service_role;
ALTER FUNCTION public.delete_operator_hand_archive_by_secret(text)
  OWNER TO service_role;

COMMIT;
