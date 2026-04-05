import './RangeMatrix.css';

const RANKS = ['A','K','Q','J','T','9','8','7','6','5','4','3','2'];

function getColor(action, freq) {
  const pct = Math.min(Math.max(freq || 0, 0), 1);
  if (action === 'fold' || pct === 0) return '#1f2937';
  if (action === 'call') return `hsl(210, 70%, ${40 + (1 - pct) * 35}%)`;
  if (action === 'mix') return `hsl(280, 65%, ${35 + (1 - pct) * 25}%)`;
  return `hsl(140, 65%, ${35 + (1 - pct) * 30}%)`;
}

function buildMatrix(matrix = {}) {
  return RANKS.map((rankA, rowIndex) =>
    RANKS.map((rankB, colIndex) => {
      const isPair = rowIndex === colIndex;
      const suited = rowIndex < colIndex ? 's' : rowIndex > colIndex ? 'o' : '';
      const label = isPair ? `${rankA}${rankB}` : `${rankA}${rankB}${suited}`;
      const entry = matrix[label] || { action: 'fold', freq: 0 };
      return {
        label,
        action: entry.action,
        freq: entry.freq || 0,
        color: getColor(entry.action, entry.freq || 0)
      };
    })
  );
}

export function RangeMatrix({ matrix, onSelect }) {
  const rows = buildMatrix(matrix);
  return (
    <div className="matrix">
      {rows.map((row, r) => (
        <div className="matrix-row" key={`row-${r}`}>
          {row.map((cell) => (
            <button
              type="button"
              className="matrix-cell"
              style={{ backgroundColor: cell.color }}
              key={cell.label}
              onClick={() => onSelect?.(cell)}
            >
              {cell.label}
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}
