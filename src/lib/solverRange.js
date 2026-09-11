const RANKS = ['A', 'K', 'Q', 'J', 'T', '9', '8', '7', '6', '5', '4', '3', '2'];
const RANK_INDEX = new Map(RANKS.map((rank, index) => [rank, index]));
const TOTAL_COMBOS = 1326;

function combosForLabel(label) {
  if (label.length === 2) return 6;
  if (label.endsWith('s')) return 4;
  return 12;
}

function normalizeClassLabel(rawLabel) {
  const label = rawLabel.toUpperCase();
  const first = label[0];
  const second = label[1];
  const suffix = rawLabel.slice(2).toLowerCase();
  if (!RANK_INDEX.has(first) || !RANK_INDEX.has(second)) return null;
  if (first === second) return suffix ? null : `${first}${second}`;
  if (!['s', 'o'].includes(suffix)) return null;
  return RANK_INDEX.get(first) < RANK_INDEX.get(second)
    ? `${first}${second}${suffix}`
    : `${second}${first}${suffix}`;
}

function orderedLabels() {
  return RANKS.flatMap((rowRank, rowIndex) => (
    RANKS.map((columnRank, columnIndex) => {
      if (rowIndex === columnIndex) return `${rowRank}${rowRank}`;
      return rowIndex < columnIndex
        ? `${rowRank}${columnRank}s`
        : `${columnRank}${rowRank}o`;
    })
  ));
}

const LABEL_ORDER = orderedLabels();

export function rangeMapToSolverText(rangeMap = {}) {
  return LABEL_ORDER.flatMap((label) => {
    const weight = Math.max(0, Math.min(1, Number(rangeMap[label]?.weight ?? 0)));
    if (weight <= 0) return [];
    if (weight >= 1) return [label];
    return [`${label}:${Number(weight.toFixed(6))}`];
  }).join(',');
}

// The matrix can faithfully restore exact 169-class lists. More compact solver
// forms such as TT+ and exact suit combos are still accepted as raw imports.
export function solverTextToRangeMap(value = '') {
  const groups = value.split(',').map((group) => group.trim()).filter(Boolean);
  if (groups.length === 0) return {};
  const next = {};
  for (const group of groups) {
    const match = /^([AKQJT2-9]{2}(?:[so])?)(?::((?:0(?:\.\d*)?|1(?:\.0*)?|\.\d+)))?$/i.exec(group);
    if (!match) return null;
    const label = normalizeClassLabel(match[1]);
    if (!label) return null;
    const weight = match[2] === undefined ? 1 : Number(match[2]);
    if (!Number.isFinite(weight) || weight < 0 || weight > 1) return null;
    if (weight > 0) next[label] = { weight };
  }
  return next;
}

export function summarizeSolverRange(rangeMap = {}) {
  const entries = Object.entries(rangeMap);
  const combos = entries.reduce((sum, [label, value]) => (
    sum + combosForLabel(label) * Math.max(0, Math.min(1, Number(value?.weight ?? 0)))
  ), 0);
  return { cells: entries.length, combos, coverage: combos / TOTAL_COMBOS };
}
