import { useMemo, useState } from 'react';
import './RangeMatrix.css';

const RANKS = ['A', 'K', 'Q', 'J', 'T', '9', '8', '7', '6', '5', '4', '3', '2'];

function buildCells(rangeMap = {}) {
  return RANKS.map((rowRank, rowIdx) => (
    RANKS.map((colRank, colIdx) => {
      const isPair = rowIdx === colIdx;
      const suited = rowIdx < colIdx ? 's' : rowIdx > colIdx ? 'o' : '';
      const label = isPair ? `${rowRank}${colRank}` : `${rowRank}${colRank}${suited}`;
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

export function RangeEditor({ open, title = '选择范围', range = {}, onChange, onClose }) {
  const [activeCell, setActiveCell] = useState(null);
  const [internal, setInternal] = useState(() => range ?? {});

  const cells = useMemo(() => buildCells(internal), [internal]);

  if (!open) return null;

  const weightValue = activeCell ? (internal[activeCell]?.weight ?? 0) : 0;

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

  const applyPreset = (type) => {
    if (type === 'clear') {
      setInternal({});
      setActiveCell(null);
      return;
    }
    if (type === 'all') {
      const full = {};
      RANKS.forEach((rowRank, rowIdx) => {
        RANKS.forEach((colRank, colIdx) => {
          const isPair = rowIdx === colIdx;
          const suited = rowIdx < colIdx ? 's' : rowIdx > colIdx ? 'o' : '';
          const label = isPair ? `${rowRank}${colRank}` : `${rowRank}${colRank}${suited}`;
          full[label] = { weight: 1 };
        });
      });
      setInternal(full);
      setActiveCell(null);
    }
  };

  const handleConfirm = () => {
    onChange?.(normalizeRange(internal));
    onClose?.();
  };

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
        <div className="matrix">
          {cells.map((row, rIdx) => (
            <div className="matrix-row" key={`row-${rIdx}`}>
              {row.map((cell) => (
                <button
                  type="button"
                  key={cell.label}
                  className={`matrix-cell editable ${activeCell === cell.label ? 'active' : ''}`}
                  onClick={() => setActiveCell(cell.label)}
                >
                  <span>{cell.label}</span>
                  <small>{cell.weight > 0 ? cell.display : ''}</small>
                </button>
              ))}
            </div>
          ))}
        </div>
        {activeCell && (
          <div className="range-slider">
            <label>
              <span>{activeCell}</span>
              <input
                type="range"
                min="0"
                max="100"
                value={Math.round(weightValue * 100)}
                onChange={(e) => updateWeight(activeCell, Number(e.target.value) / 100)}
              />
              <strong>{Math.round(weightValue * 100)}%</strong>
            </label>
            <div className="quick-weights">
              {[0, 0.25, 0.5, 0.75, 1].map((val) => (
                <button key={val} type="button" onClick={() => updateWeight(activeCell, val)}>
                  {Math.round(val * 100)}%
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
