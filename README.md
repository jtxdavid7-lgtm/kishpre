# KISHPoker Tools

A lightweight poker lab built with React + Vite. It bundles two core modules today:

1. **Range Lab** – browse baseline preflop ranges (GTO + profile adjustments).
2. **Equity Calculator** – run Monte Carlo simulations for hand vs hand, hand vs range, and range vs range matchups with multiway support.

This replaces the stock Vite template README.

---

## Features

### ✳️ Range Lab
- Load baseline ranges from `src/data/base` and overlay situational adjustments driven by `src/data/profiles` + `src/data/rules`.
- Visual matrix component (`RangeMatrix`) for quick inspection.
- Adjustment log shows which profile rules fired.

### ♠️ Equity Calculator
- Add up to 6 players, mix **Hand** mode (two explicit cards) and **Range** mode (matrix picker with 13×13 combos + frequency slider).
- Handles public board cards, blocked combos, and multiway equities.
- Monte Carlo engine (`src/lib/equityEngine.js`) samples combinations respecting weights and card removal, returning per-player equities + actual iteration count.

### 🧮 Range Editor
- Modal matrix editor with quick actions (clear / select all) and 0 / 25 / 50 / 75 / 100% shortcuts.
- Summaries per player show coverage % (combos / 1326) and number of selected cells.

### 🛠️ Tooling
- React 19 + Vite 8.
- ESLint flat config (`npm run lint`).
- Production build via `npm run build`.

---

## Getting Started

```bash
# install dependencies
npm install

# start dev server (http://localhost:5173)
npm run dev

# type-check/lint
npm run lint

# production build
npm run build
npm run preview
```

Static assets under `dist/` can be deployed to any static host (Vercel, Netlify, S3, etc.).

---

## Equity Calculator Usage

1. **Players** – each card panel has a toggle: `手牌` (explicit two cards) or `范围` (open matrix editor).
2. **Board** – click slots to pin flop/turn/river cards.
3. **Simulation** – hit `开始计算`; status text reports validation errors (`need-cards`, `need-range`, `range-conflict`, etc.) or `已完成 X 次模拟` with actual iteration count.
4. **Range Editor Tips**
   - Click a cell to activate, adjust via slider or quick buttons.
   - `清空` removes all combos, `全选` marks 100% of the matrix.
   - Closing the modal without `完成` discards edits.

---

## Repository Layout

```
src/
  App.jsx          # Home + Range Lab + Equity views
  components/
    RangeMatrix.jsx
    RangeEditor.jsx
  data/
    base/          # Baseline ranges
    profiles.js    # Opponent archetypes
    rules.js       # Adjustment rules
  lib/
    equityEngine.js  # Monte Carlo simulator
    rangeEngine.js   # Range/profile payload builder
```

---

## Roadmap / Ideas

- Import/export range presets (JSON / text aliases).
- Support equity graphing across run-outs & board filters.
- Merge Range Lab selections directly into Equity Calculator presets.

PRs / issues welcome.
