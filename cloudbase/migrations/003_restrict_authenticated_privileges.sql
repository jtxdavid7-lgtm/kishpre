BEGIN;

REVOKE ALL ON TABLE
  public.profiles,
  public.poker_accounts,
  public.privacy_consents,
  public.import_batches,
  public.sessions,
  public.hands,
  public.import_batch_hands
FROM authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  public.profiles,
  public.poker_accounts
TO authenticated;

GRANT SELECT, INSERT ON TABLE public.privacy_consents TO authenticated;

GRANT SELECT, INSERT, DELETE ON TABLE
  public.import_batches,
  public.sessions,
  public.hands,
  public.import_batch_hands
TO authenticated;

COMMIT;
