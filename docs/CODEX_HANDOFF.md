# K2note / kishpoker.cn - Project Handoff

Last updated: 2026-07-17

## Purpose

This project builds and maintains K2note, a GG hand-history analysis website inspired by Hand2Note/GG reports while keeping its own UI and statistically correct definitions.

- Main site: `kishpoker.cn`
- GitHub repository: `https://github.com/jtxdavid7-lgtm/kishpre.git`
- Local source repository: `F:\Codex\kishpoker-site`
- Deploy worktree: `F:\Codex\kishpoker-gh-pages-deploy`

Speak Chinese by default.

## Current Direction

K2note is the main product and the lead feature on the homepage. RangeLab, equity, and variance tools remain secondary modules.

GG files are parsed locally in the browser. Cloud writes are independent and explicit:

- A signed-in user can save hands to a private personal library.
- A visitor or signed-in user can separately consent to an operator analysis copy.
- Declining either cloud flow must not block local analysis.
- Do not upload filenames or content that was not recognized as a GG hand history.

## Current Product State

Latest source state before this documentation commit: `f138a09` (`Add player pool leak explorer`).

Implemented:

- Local GG parsing for text files, multiple files, folders, ZIP and additional archive formats through `libarchive.js`.
- Overview, detail, history, starting-hand matrix, position views, filters, sorting, BB/currency display and pagination.
- Hand-history detail view and a visual replay player.
- Time, stake, game-type, position, hole-card and board filtering.
- Profit/EV graphs, core poker stats, hand-type aggregation and BB/100 reporting.
- K2note homepage/product positioning and responsive layout.
- CloudBase account system with mainland-China phone authentication, password login, SMS registration/verification, Google login and Google account linking.
- Google OAuth draft preservation: a local analysis is temporarily stored in IndexedDB before the redirect and restored after return.
- Per-user personal hand libraries, deduplication, datasets and server-side filters.
- Explicitly consented operator hand archive, including anonymous-device identities, revocation/deletion support, durable browser queue, batching and retry.
- Operator corpus export/sync script with SHA-256 validation, deduplication and snapshot manifests.
- Player-pool leak explorer and its versioned static dataset.

## Repository Map

- `src/App.jsx` and `src/App.css`: main application, homepage and analyzer UI.
- `src/lib/handHistoryAnalyzer.js`: parser and poker-stat calculations.
- `src/lib/cloudbaseClient.js`: CloudBase authentication and SDK initialization.
- `src/lib/cloudLibrary.js`: personal libraries, datasets, cloud save/read/filter logic.
- `src/lib/operatorArchive.js`: consented operator archive orchestration.
- `src/lib/operatorArchiveQueue.js`: durable IndexedDB upload queue.
- `src/lib/oauthAnalysisDraft.js`: local preservation around Google OAuth redirects.
- `src/components/PoolLeakExplorer.jsx`: player-pool leak explorer.
- `cloudbase/migrations/`: PostgreSQL schema, RLS/RPC and archive migrations.
- `scripts/export-operator-hand-corpus.mjs`: validated operator-corpus export/sync.
- `scripts/sync-pool-leaks.mjs`: validates and publishes the leak-explorer dataset.
- `tests/`: Vitest coverage plus an opt-in live CloudBase smoke test.

## Local Setup on Another Computer

```powershell
git clone https://github.com/jtxdavid7-lgtm/kishpre.git
cd kishpre
npm.cmd install
Copy-Item .env.example .env.local
npm.cmd run dev
```

Fill `.env.local` with the CloudBase web configuration from the CloudBase console:

```text
VITE_CLOUDBASE_ENV_ID=...
VITE_CLOUDBASE_REGION=ap-shanghai
VITE_CLOUDBASE_ACCESS_KEY=...
```

`.env.local` is intentionally ignored. Never commit it. Copy it to the laptop through a private channel or retrieve the web publishable configuration from CloudBase. The browser bundle must not contain an admin key, database password, Google client secret, CLI token or service-account credential.

The local operator hand corpus is also intentionally outside Git. Its default location is `D:\K2note玩家池牌谱库`; copy it separately only if it is needed on the laptop.

## CloudBase and Authentication

- CloudBase region: `ap-shanghai`.
- Phone-number login, username/password login and anonymous login are enabled in the CloudBase environment.
- New phone users use the CloudBase v3 `auth.signUp({ phone, password })` flow and verify the returned OTP.
- Existing phone users can use password login or an SMS verification flow.
- Google is configured as an external OIDC/OAuth provider in CloudBase.
- Google OAuth authorized redirect URIs must exactly match the callback URI CloudBase sends. A mismatch produces `redirect_uri_mismatch`.
- The Google OAuth app may remain in testing while only listed test users need access; publishing is required for general external users.
- Do not confuse CloudBase allowed web domains/CORS domains with Google OAuth redirect URIs; both configurations are required.

Database migrations currently present:

1. `001_initial.sql`
2. `002_unique_hand_content.sql`
3. `003_restrict_authenticated_privileges.sql`
4. `004_hand_libraries_and_filters.sql`
5. `005_operator_hand_archive.sql`

Run a migration only after checking the target environment and reviewing the SQL:

```powershell
node scripts/apply-cloudbase-pg-migration.mjs
```

The migration helper reads local environment configuration and invokes CloudBase tooling. Do not paste production credentials into source files.

## Operator Corpus

Manual export:

```powershell
npm.cmd run export:operator-corpus
```

Incremental check and sync:

```powershell
npm.cmd run sync:operator-corpus
```

The sync compares the cloud summary/fingerprint with the latest local manifest. When changed, it creates and validates a new deduplicated snapshot before removing recognized older snapshots. Generated hand-history text and ZIP files are production data and must never be committed to GitHub.

The requested once-or-twice-daily automatic sync task has not yet been created. A Windows scheduled task runs only while that computer is on (or resumes later if configured). For guaranteed execution while the laptop/desktop is off, use a continuously running server or a secure cloud scheduled job with secrets stored in the platform secret manager.

## Player-Pool Leak Explorer

- Versioned browser dataset lives under `public/data/pool-leaks/v1/`.
- `npm.cmd run sync:pool-leaks` validates row counts, numeric ranges, frequency closure, board classes and the dataset manifest before publishing changes.
- Keep raw/private player-pool hand histories outside the repository; only reviewed aggregate datasets belong under `public/`.

## Existing Features

- GG hand-history parsing
- `.txt`, `.zip`, multiple files, and folders
- additional archive support through `libarchive.js`
- local parsing remains usable without any server upload
- overview and detail tabs
- position and stake filters
- graph lines with toggles, tooltips, and end labels
- water-before, water-after, and rake logic
- PVI input calculation
- downsampling for large hand-history curves
- homepage positioning work

The older list above describes the analyzer foundation; the “Current Product State” section is authoritative for newer account/cloud/player-pool work.

## Test Data

Known test file: `C:\Users\Administrator\Desktop\test.zip`

It contains four GG RushAndCash text files and 6,309 hands.

## Current Analyzer Calibration

Reference target is the user's screenshot of a Ban2Note-like site using `test.zip`.

Already aligned or considered stable:

- Hands
- Winnings
- bb/100
- VPIP
- PFR
- 3Bet
- Squeeze
- 4Bet
- Steal Total
- Steal BTN
- Steal SB
- WWSF
- WTSD
- W$SD
- CheckC
- CheckR
- Flop CBet
- Turn CBet
- River CBet overall

Recent source commits:

- `130c113` - Align cbet and fourbet detail stats
- `7d14769` - Align fold to cbet aggressor
- `9965aa8` - Tighten donk opportunity detection

Latest deployed state at this handoff: `c4f1bf5` with bundle `index-BICpIjm6.js`.

## Metric Decisions

### FvCB

- Facing a cbet and raising counts in the FvCB denominator.
- Do not exclude raises merely to match a reference screenshot.

### Donk

- Flop, Turn, and River Donk should all be implemented.
- The previous-street aggressor must still be active.
- Hero acts before that aggressor on the current street.
- No one has bet before Hero.
- Hero betting in that spot counts as Donk.

### CBet

- The CBet aggressor is the preflop aggressor.
- CBet IP/OOP is based on current-street action order:
  - Hero first to act means OOP.
  - Hero acts after at least one player means IP.

### 4Bet

The current screenshot-matching definition is cold 4bet on Hero's first action facing an open and a 3bet.

## Remaining Calibration

- Fold to 3Bet
- Fold to 4Bet
- FvCB edge cases
- River CBet IP/OOP split
- Donk sample and definition validation across more files

Some differences may come from the reference site's implementation. Prefer correct poker definitions once the user confirms them.

## Near-Term Follow-ups

- Re-test phone registration, password login, SMS login and Google login end-to-end against production after any CloudBase auth-console change.
- Finish the scheduled operator-corpus sync design and decide whether it should run on Windows or a persistent server.
- Continue poker-stat calibration listed above using more GG formats and stakes.
- Continue player-pool leak explorer iterations and document the provenance/version of every aggregate dataset.
- Consider code-splitting the current large production bundles; Vite reports chunks over 500 kB, but the build succeeds.

## Validation

Run from `F:\Codex\kishpoker-site`:

```powershell
npm.cmd run build
npm.cmd run lint
npm.cmd test
```

`tests/operatorArchive.live.test.js` is skipped by default and should only be enabled deliberately against the intended CloudBase environment.

## Deployment

Build the source repository first:

```powershell
npm.cmd run build
```

Then copy `dist` into the deploy worktree:

```powershell
$deploy = (Resolve-Path -LiteralPath 'F:\Codex\kishpoker-gh-pages-deploy').Path
$expected = 'F:\Codex\kishpoker-gh-pages-deploy'
if ($deploy -ne $expected) { throw "Unexpected deploy path: $deploy" }
$dist = (Resolve-Path -LiteralPath 'F:\Codex\kishpoker-site\dist').Path
Set-Content -LiteralPath (Join-Path $dist 'CNAME') -Value 'www.kishpoker.cn' -Encoding ASCII
Get-ChildItem -LiteralPath $deploy -Force | Where-Object { $_.Name -ne '.git' } | Remove-Item -Recurse -Force
Get-ChildItem -LiteralPath $dist -Force | Copy-Item -Destination $deploy -Recurse -Force
git -C $deploy add -A
git -C $deploy commit -m "<deploy message>"
git -C $deploy push origin gh-pages:gh-pages
```

Push source separately with `git push origin main`.

GitHub Pages may lag behind the `gh-pages` branch. If needed, verify `git show gh-pages:index.html`; an empty commit can trigger a Pages rebuild.

## Git and Data Safety

- Source branch: `main`.
- Production static branch: `gh-pages` (maintained in the separate deploy worktree).
- Do not commit `.env.local`, `node_modules/`, `dist/`, local GG archives, exported operator corpora, temporary SQL credentials or browser-profile data.
- Before pushing, run `git status`, `git diff --check`, tests, lint and build.
- Deploy only when the user explicitly requests it; pushing documentation/source alone does not require a site deployment.
