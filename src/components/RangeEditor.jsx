import { useMemo, useState } from 'react';
import handStrength from '../data/handStrength.json';
import './RangeMatrix.css';

const RANKS = ['A', 'K', 'Q', 'J', 'T', '9', '8', '7', '6', '5', '4', '3', '2'];
const TOTAL_COMBOS = 1326;
const HAND_STRENGTH_ORDER = handStrength?.order ?? [];

function combosForLabel(label = '') {
  if (label.length === 2) return 6;
  if (label.endsWith('s')) return 4;
  return 12;
}

function buildCells(rangeMap = {}) {
  return RANKS.map((rowRank, rowIdx) => (
    RANKS.map((colRank, colIdx) => {
      const isPair = rowIdx === colIdx;
      const suited = rowIdx < colIdx ? 's' : rowIdx > colIdx ? 'o' : '';
      const high = rowIdx <= colIdx ? rowRank : colRank;
      const low = rowIdx <= colIdx ? colRank : rowRank;
      const label = isPair ? `${rowRank}${rowRank}` : `${high}${low}${suited}`;
      const weight = rangeMap[label]?.weight ?? 0;
      return {
        label,
        weight,
        display: `${Math.round(weight * 100)}%`
      };
    })
  ));
}

function normalizeRange(rangeMap = {}) {
  return Object.fromEntries(
    Object.entries(rangeMap)
      .filter(([, value]) => (value?.weight ?? 0) > 0)
      .map(([combo, value]) => [combo, { weight: Math.min(Math.max(value.weight ?? 0, 0), 1) }])
  );
}

function calculateCoverage(rangeMap = {}) {
  const combos = Object.entries(rangeMap).reduce((sum, [label, value]) => (
    sum + combosForLabel(label) * (value?.weight ?? 0)
  ), 0);
  return combos / TOTAL_COMBOS;
}

function buildCoverageRange(percent, ranking) {
  const clamp = Math.max(0, Math.min(100, percent));
  const target = clamp / 100 * TOTAL_COMBOS;
  if (target === 0) return {};
  const next = {};
  let remaining = target;
  for (let idx = 0; idx < ranking.length && remaining > 0; idx += 1) {
    const item = ranking[idx];
    const label = typeof item === 'string' ? item : item?.label;
    if (!label) continue;
    const combos = combosForLabel(label);
    if (remaining >= combos) {
      next[label] = { weight: 1 };
      remaining -= combos;
    } else {
      next[label] = { weight: remaining / combos };
      remaining = 0;
    }
  }
  return next;
}

export function RangeEditor({ open, title = '选择范围', range = {}, onChange, onClose }) {
  const [activeCell, setActiveCell] = useState(null);
  const [internal, setInternal] = useState(() => range ?? {});
  const [paintValue, setPaintValue] = useState(1);

  const cells = useMemo(() => buildCells(internal), [internal]);
  const coveragePercent = Math.round(calculateCoverage(internal) * 100);

  const ranking = useMemo(() => {
    if (HAND_STRENGTH_ORDER.length > 0) return HAND_STRENGTH_ORDER;
    const fallback = [];
    RANKS.forEach((rowRank, rowIdx) => {
      RANKS.forEach((colRank, colIdx) => {
        const isPair = rowIdx === colIdx;
        const suited = rowIdx < colIdx ? 's' : rowIdx > colIdx ? 'o' : '';
        const high = rowIdx <= colIdx ? rowRank : colRank;
        const low = rowIdx <= colIdx ? colRank : rowRank;
        const label = isPair ? `${rowRank}${rowRank}` : `${high}${low}${suited}`;
        fallback.push(label);
      });
    });
    return fallback;
  }, []);

  if (!open) return null;

  const updateWeight = (label, weight) => {
    setInternal((prev) => {
      const next = { ...prev };
      if (weight <= 0) {
        delete next[label];
      } else {
        next[label] = { weight: Math.min(Math.max(weight, 0), 1) };
      }
      return next;
    });
  };

  const handleCellClick = (label) => {
    setActiveCell(label);
    updateWeight(label, paintValue);
  };

  const applyPreset = (type) => {
    if (type === 'clear') {
      setInternal({});
      setActiveCell(null);
      return;
    }
    if (type === 'all') {
      const full = {};
      ranking.forEach((item) => {
        const label = typeof item === 'string' ? item : item?.label;
        if (label) {
          full[label] = { weight: 1 };
        }
      });
      setInternal(full);
      setActiveCell(null);
    }
  };

  const applyCoverage = (value) => {
    const next = buildCoverageRange(Number(value), ranking);
    setInternal(next);
    setActiveCell(null);
  };

  const handleConfirm = () => {
    onChange?.(normalizeRange(internal));
    onClose?.();
  };

  const paintOptions = [1, 0.75, 0.5, 0.25, 0];

  return (
    <div className="picker-backdrop">
      <div className="picker-panel range-editor">
        <div className="picker-head">
          <strong>{title}</strong>
          <div className="picker-actions">
            <button type="button" onClick={() => applyPreset('clear')}>清空</button>
            <button type="button" onClick={() => applyPreset('all')}>全选</button>
            <button type="button" className="primary" onClick={handleConfirm}>完成</button>
            <button type="button" onClick={onClose}>×</button>
          </div>
        </div>

        <div className="coverage-controls">
          <label>
            <span>范围覆盖</span>
            <strong>{coveragePercent}%</strong>
          </label>
          <input
            type="range"
            min="0"
            max="100"
            value={coveragePercent}
            onChange={(e) => applyCoverage(e.target.value)}
          />
        </div>

        <div className="paint-controls">
          <span>点击牌型时使用的频率</span>
          <div className="quick-weights compact">
            {paintOptions.map((val) => (
              <button
                key={`paint-${val}`}
                type="button"
                className={paintValue === val ? 'active' : ''}
                onClick={() => setPaintValue(val)}
              >
                {Math.round(val * 100)}%
              </button>
            ))}
          </div>
        </div>

        <div className="matrix-scroll">
          <div className="matrix">
            {cells.map((row, rIdx) => (
              <div className="matrix-row" key={`row-${rIdx}`}>
                {row.map((cell) => {
                  const fill = Math.max(0, Math.min(cell.weight, 1));
                  const filledClass = fill > 0 ? 'filled' : '';
                  const style = fill > 0
                    ? { backgroundImage: `linear-gradient(180deg, rgba(34,197,94,0.92) ${fill * 100}%, rgba(15,23,42,0.88) ${fill * 100}%)` }
                    : {};
                  return (
                    <button
                      type="button"
                      key={cell.label}
                      className={`matrix-cell editable ${filledClass} ${activeCell === cell.label ? 'active' : ''}`}
                      style={style}
                      onClick={() => handleCellClick(cell.label)}
                    >
                      <span>{cell.label}</span>
                      <small>{cell.weight > 0 ? cell.display : ''}</small>
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
