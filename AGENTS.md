# KishPoker Tools Instructions

- Speak Chinese by default.
- Read `docs/CODEX_HANDOFF.md` before substantial implementation or analysis.
- This repository is the source for `kishpoker.cn`; keep changes scoped to the user's request and preserve existing behavior.
- The GG hand-history analyzer always parses user files locally in the browser. Existing personal-cloud-library and operator-corpus uploads are separate, consented flows; do not broaden their scope or introduce another upload path without explicit user approval and a privacy design.
- Never commit `.env.local`, credentials, user hand histories, operator corpus exports, or other production data.
- Prefer correct poker-stat definitions over matching a third-party site's bugs or incomplete implementation.
- Validate implementation changes with `npm.cmd run build` and `npm.cmd run lint`.
- Deploy only when the user requests it, following the procedure in `docs/CODEX_HANDOFF.md`.
