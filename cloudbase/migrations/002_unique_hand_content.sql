BEGIN;

CREATE UNIQUE INDEX hands_owner_content_sha_unique
  ON public.hands (user_id, content_sha256);

COMMIT;
