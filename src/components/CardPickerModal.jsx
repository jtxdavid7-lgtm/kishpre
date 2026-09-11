const SUIT_ICON = { s: '♠', h: '♥', d: '♦', c: '♣' };
const PICKER_RANKS = ['A', 'K', 'Q', 'J', 'T', '9', '8', '7', '6', '5', '4', '3', '2'];
const PICKER_SUITS = ['s', 'h', 'c', 'd'];

export function CardPickerModal({
  open,
  onClose,
  onSelect,
  takenCards = new Set(),
  currentValue = null,
  title = '选择牌'
}) {
  if (!open) return null;

  return (
    <div className="picker-backdrop">
      <div className="picker-panel">
        <div className="picker-head">
          <strong>{title}</strong>
          <button type="button" onClick={onClose}>×</button>
        </div>
        <div className="card-grid modal-grid">
          {PICKER_SUITS.flatMap((suit) => (
            PICKER_RANKS.map((rank) => {
              const card = `${rank}${suit}`;
              const disabled = takenCards.has(card) && card !== currentValue;
              return (
                <button
                  key={card}
                  type="button"
                  className={`card-button suit-${suit} ${disabled ? 'disabled' : ''}`}
                  disabled={disabled}
                  onClick={() => onSelect(card)}
                  aria-label={`${rank}${suit}`}
                >
                  <span className="card-rank">{rank}</span>
                  <span className="card-pip">{SUIT_ICON[suit]}</span>
                </button>
              );
            })
          ))}
        </div>
      </div>
    </div>
  );
}
