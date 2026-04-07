import { useMemo, useRef, useState } from 'react';
import { RangeMatrix } from './components/RangeMatrix.jsx';
import { RangeEditor } from './components/RangeEditor.jsx';
import { BASE_RANGES } from './data/base';
import { PROFILES } from './data/profiles';
import { getRangePayload } from './lib/rangeEngine';
import { deckList, simulateEquity } from './lib/equityEngine';
import './App.css';

const sceneOptions = Object.values(BASE_RANGES).map((range) => ({
  value: range.key,
  label: `${range.meta.position} · ${range.meta.actionTree}`
}));

const profileOptions = Object.values(PROFILES).map((profile) => ({
  value: profile.key,
  label: profile.label
}));

const SUIT_ICON = { s: '♠', h: '♥', d: '♦', c: '♣' };
const emptyHand = () => Array(2).fill(null);
const boardTemplate = () => Array(5).fill(null);
const TOTAL_COMBOS = 1326;

const formatCard = (card) => {
  if (!card) return '--';
  const [rank, suit] = [card[0], card[1]];
  return `${rank}${SUIT_ICON[suit] ?? ''}`;
};

const combosForLabel = (label = '') => {
  if (label.length === 2) return 6; // pocket pairs
  if (label.endsWith('s')) return 4; // suited combos
  return 12; // offsuit combos
};

const summarizeRange = (range = {}) => {
  const entries = Object.entries(range);
  const comboWeight = entries.reduce((sum, [label, value]) => (
    sum + combosForLabel(label) * (value?.weight ?? 0)
  ), 0);
  const coverage = comboWeight / TOTAL_COMBOS;
  return {
    cells: entries.length,
    combos: comboWeight,
    coverage
  };
};

function RangeLabView() {
  const [sceneKey, setSceneKey] = useState(sceneOptions[0]?.value ?? 'BTN_open_100bb');
  const [profileKey, setProfileKey] = useState(profileOptions[0]?.value ?? 'tag');
  const [viewMode, setViewMode] = useState('adjusted');
  const [activeCell, setActiveCell] = useState(null);

  const payload = useMemo(
    () => getRangePayload({ sceneKey, profileKey }),
    [sceneKey, profileKey]
  );

  const currentMatrix = viewMode === 'adjusted'
    ? payload?.matrices?.adjusted
    : payload?.matrices?.base;

  return (
    <div className="site">
      <nav className="top-nav">
        <div className="brand">KISHPOKER · Range Lab</div>
        <div className="cta-row">
          <button type="button" className="secondary" onClick={() => window.location.assign('/')}>主页</button>
          <button type="button" className="secondary" onClick={() => window.location.assign('?tool=equity')}>胜率计算</button>
        </div>
      </nav>

      <section className="range-panel" style={{ marginTop: 0 }}>
        <header>
          <p className="eyebrow">GG Zoom · 100bb</p>
          <h2>Preflop Range Lab</h2>
          <p className="subtext">快速查看 GTO 基准并根据对手画像自动调整</p>
        </header>

        <section className="controls">
          <label>
            <span>场景</span>
            <select value={sceneKey} onChange={(e) => setSceneKey(e.target.value)}>
              {sceneOptions.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </label>

          <label>
            <span>对手画像</span>
            <select value={profileKey} onChange={(e) => setProfileKey(e.target.value)}>
              {profileOptions.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </label>
        </section>

        {payload?.exists ? (
          <>
            <section className="meta">
              <div>
                <h3>{payload.base.meta.position} · {payload.base.meta.actionTree}</h3>
                <p>{payload.base.meta.game} · {payload.base.meta.stack}</p>
                <p>对手：{payload.profile?.label ?? '未指定'}</p>
              </div>
              <div className="mode-switch">
                <button
                  type="button"
                  className={viewMode === 'base' ? 'active' : ''}
                  onClick={() => setViewMode('base')}
                >纯 GTO</button>
                <button
                  type="button"
                  className={viewMode === 'adjusted' ? 'active' : ''}
                  onClick={() => setViewMode('adjusted')}
                >已调整</button>
              </div>
            </section>

            <section className="matrix-block">
              <RangeMatrix
                matrix={currentMatrix}
                onSelect={(cell) => setActiveCell(cell)}
              />

              {activeCell && (
                <div className="detail">
                  <p>{activeCell.label}</p>
                  <p>{activeCell.action} · {(activeCell.freq * 100).toFixed(0)}%</p>
                </div>
              )}
            </section>

            {payload.matchedRules.length > 0 && (
              <section className="rules">
                <h3>触发的调整</h3>
                {payload.matchedRules.map((rule) => (
                  <article key={rule.id}>
                    <strong>{rule.label}</strong>
                    <p>{rule.note}</p>
                  </article>
                ))}
              </section>
            )}
          </>
        ) : (
          <div className="error">{payload?.message ?? '暂无数据'}</div>
        )}
      </section>
    </div>
  );
}

function EquityView() {
  const createPlayer = (id, label) => ({
    id,
    label,
    mode: 'hand',
    cards: emptyHand(),
    range: {}
  });
  const defaultPlayers = () => [createPlayer('hero', 'Hero'), createPlayer('villain-1', '玩家2')];

  const [players, setPlayers] = useState(() => defaultPlayers());
  const [boardCards, setBoardCards] = useState(() => boardTemplate());
  const [pickerTarget, setPickerTarget] = useState(null);
  const [rangeEditorTarget, setRangeEditorTarget] = useState(null);
  const [result, setResult] = useState(null);
  const [status, setStatus] = useState('idle');
  const counterRef = useRef(2);

  const takenCards = useMemo(() => new Set([
    ...boardCards,
    ...players.flatMap((player) => (player.mode === 'hand' ? player.cards : []))
  ].filter(Boolean)), [boardCards, players]);

  const openRangeEditor = (playerId) => setRangeEditorTarget({ playerId, sessionId: Date.now() });

  const applyRangeToPlayer = (playerId, nextRange) => {
    setPlayers((prev) => prev.map((player) => (
      player.id === playerId
        ? { ...player, range: nextRange }
        : player
    )));
    setResult(null);
    setStatus('idle');
  };

  const setPlayerMode = (playerId, mode) => {
    setPlayers((prev) => prev.map((player) => (
      player.id === playerId
        ? { ...player, mode }
        : player
    )));
    setResult(null);
    setStatus('idle');
  };

  const iterations = 5000;

  const openPicker = (target) => {
    const currentValue = target.type === 'board'
      ? boardCards[target.index]
      : players.find((player) => player.id === target.playerId)?.cards[target.index];
    setPickerTarget({ ...target, currentValue });
  };

  const updatePlayerCard = (playerId, slotIndex, value) => {
    setPlayers((prev) => prev.map((player) => (
      player.id === playerId
        ? { ...player, cards: player.cards.map((card, idx) => (idx === slotIndex ? value : card)) }
        : player
    )));
  };

  const updateBoardCard = (index, value) => {
    setBoardCards((prev) => {
      const next = [...prev];
      next[index] = value;
      return next;
    });
  };

  const handlePick = (card) => {
    if (!pickerTarget) return;
    if (takenCards.has(card) && card !== pickerTarget.currentValue) return;

    if (pickerTarget.type === 'board') {
      updateBoardCard(pickerTarget.index, card);
    } else {
      updatePlayerCard(pickerTarget.playerId, pickerTarget.index, card);
    }
    setPickerTarget(null);
  };

  const clearSlot = (target) => {
    if (target.type === 'board') {
      updateBoardCard(target.index, null);
    } else {
      updatePlayerCard(target.playerId, target.index, null);
    }
    setResult(null);
  };

  const addPlayer = () => {
    if (players.length >= 6) return;
    counterRef.current += 1;
    setPlayers((prev) => ([
      ...prev,
      createPlayer(`villain-${counterRef.current}`, `玩家${prev.length + 1}`)
    ]));
  };

  const removePlayer = (playerId) => {
    if (players.length <= 2) return;
    setPlayers((prev) => prev.filter((player) => player.id !== playerId));
    setResult(null);
  };

  const resetAll = () => {
    counterRef.current = 2;
    setPlayers(defaultPlayers());
    setBoardCards(boardTemplate());
    setResult(null);
    setStatus('idle');
    setPickerTarget(null);
  };

  const runSimulation = () => {
    if (players.length < 2) {
      setStatus('need-players');
      return;
    }
    if (players.some((player) => player.mode === 'hand' && player.cards.filter(Boolean).length !== 2)) {
      setStatus('need-cards');
      return;
    }
    if (players.some((player) => player.mode === 'range' && Object.keys(player.range || {}).length === 0)) {
      setStatus('need-range');
      return;
    }
    setStatus('running');
    setResult(null);
    setTimeout(() => {
      const sim = simulateEquity({
        players: players.map((player, idx) => ({
          id: player.id,
          label: idx === 0 ? 'Hero' : player.label,
          mode: player.mode,
          cards: player.cards,
          range: player.range
        })),
        boardCards,
        iterations
      });
      setResult(sim);
      setStatus(sim.status === 'ok' ? 'done' : sim.status);
    }, 20);
  };

  const heroEquity = result?.players?.[0]?.equity ?? 0;
  const currentRangePlayer = rangeEditorTarget
    ? players.find((player) => player.id === rangeEditorTarget.playerId)
    : null;
  const flopComplete = boardCards.slice(0, 3).every(Boolean);
  const turnComplete = Boolean(boardCards[3]);

  return (
    <div className="site">
      <nav className="top-nav">
        <div className="brand">KISHPOKER · 胜率计算</div>
        <div className="cta-row">
          <button type="button" className="secondary" onClick={() => window.location.assign('/')}>主页</button>
          <button type="button" className="secondary" onClick={() => window.location.assign('?tool=range')}>Range Lab</button>
        </div>
      </nav>

      <section className="range-panel" style={{ marginTop: 0 }}>
        <header>
          <p className="eyebrow">德州计算器</p>
          <h2>胜率计算工具</h2>
          <p className="subtext">为每位玩家指定手牌，或切换到「范围」用矩阵编辑器点选组合。</p>
        </header>

        {result?.status === 'ok' && (
          <div className="result-stack">
            <div className="hero-summary">
              <p>Hero 胜率</p>
              <strong>{(heroEquity * 100).toFixed(1)}%</strong>
            </div>
            <div className="equity-table">
              {result.players.map((player) => (
                <div key={player.id}>
                  <p>{player.label}</p>
                  <strong>{(player.equity * 100).toFixed(1)}%</strong>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="board-section">
          <h4>公共牌</h4>
          <div className="card-slots board-cards">
            {boardCards.map((card, idx) => {
              const locked = !card && ((idx >= 3 && !flopComplete) || (idx === 4 && !turnComplete));
              const classes = ['card-slot', 'board-slot'];
              if (!card) classes.push('empty');
              if (locked) classes.push('locked');
              return (
                <button
                  key={`board-${idx}`}
                  type="button"
                  className={classes.join(' ')}
                  onClick={() => {
                    if (locked) return;
                    openPicker({ type: 'board', index: idx });
                  }}
                  disabled={locked}
                  title={locked ? (idx >= 3 && !flopComplete ? '请先选好前3张' : '请先选好转牌') : undefined}
                >
                  <span className="card-face">{formatCard(card)}</span>
                  {card && (
                    <span
                      className="slot-clear"
                      onClick={(e) => {
                        e.stopPropagation();
                        clearSlot({ type: 'board', index: idx });
                      }}
                    >×</span>
                  )}
                </button>
              );
            })}
          </div>
        </div>

        <div className="players-grid">
          {players.map((player, idx) => {
            const summary = summarizeRange(player.range);
            return (
              <div key={player.id} className="player-card">
                <div className="player-header">
                  <div>
                    <h4>{idx === 0 ? 'Hero' : player.label}</h4>
                    <div className="mode-switch compact">
                      <button
                        type="button"
                        className={player.mode === 'hand' ? 'active' : ''}
                        onClick={() => setPlayerMode(player.id, 'hand')}
                      >手牌</button>
                      <button
                        type="button"
                        className={player.mode === 'range' ? 'active' : ''}
                        onClick={() => setPlayerMode(player.id, 'range')}
                      >范围</button>
                    </div>
                  </div>
                  {idx > 0 && players.length > 2 && (
                    <button type="button" onClick={() => removePlayer(player.id)}>移除</button>
                  )}
                </div>

                {player.mode === 'hand' ? (
                  <div className="card-slots">
                    {player.cards.map((card, slotIdx) => (
                      <button
                        key={`${player.id}-${slotIdx}`}
                        type="button"
                        className="card-slot"
                        onClick={() => openPicker({ type: 'player', playerId: player.id, index: slotIdx })}
                      >
                        <span className="card-face">{formatCard(card)}</span>
                        {card && (
                          <span
                            className="slot-clear"
                            onClick={(e) => {
                              e.stopPropagation();
                              clearSlot({ type: 'player', playerId: player.id, index: slotIdx });
                            }}
                          >×</span>
                        )}
                      </button>
                    ))}
                  </div>
                ) : (
                  <div className="range-summary">
                    <p>
                      {summary.cells > 0
                        ? `覆盖 ${(summary.coverage * 100).toFixed(1)}% · ${summary.cells} 格`
                        : '未选择范围'}
                    </p>
                    <button type="button" onClick={() => openRangeEditor(player.id)}>编辑范围</button>
                  </div>
                )}
              </div>
            );
          })}
          {players.length < 6 && (
            <button type="button" className="add-player" onClick={addPlayer}>+ 添加对手</button>
          )}
        </div>

        <div className="equity-actions">
          <button type="button" className="primary" onClick={runSimulation}>开始计算</button>
          <button type="button" className="secondary" onClick={resetAll}>清空</button>
          <span className="status-text">
            {status === 'running' && '正在模拟...'}
            {status === 'need-cards' && '请先为所有玩家填好两张手牌'}
            {status === 'need-players' && '至少需要 2 位玩家'}
            {status === 'need-range' && '范围模式需要至少选择一个组合'}
            {status === 'range-conflict' && '所选范围互相阻断，无法生成有效组合'}
            {status === 'invalid' && '组合或公共牌冲突，请检查选择'}
            {status === 'done' && `已完成 ${result?.iterations ?? iterations} 次模拟`}
          </span>
        </div>

      </section>

      <CardPickerModal
        open={Boolean(pickerTarget)}
        currentValue={pickerTarget?.currentValue ?? null}
        takenCards={takenCards}
        onClose={() => setPickerTarget(null)}
        onSelect={handlePick}
        title="选择牌"
      />

      <RangeEditor
        key={rangeEditorTarget?.sessionId ?? 'range-editor'}
        open={Boolean(rangeEditorTarget)}
        title={`${currentRangePlayer?.label ?? '玩家'} · 范围`}
        range={currentRangePlayer?.range ?? {}}
        onClose={() => setRangeEditorTarget(null)}
        onChange={(nextRange) => {
          if (rangeEditorTarget?.playerId) {
            applyRangeToPlayer(rangeEditorTarget.playerId, nextRange);
          }
        }}
      />
    </div>
  );
}

function CardPickerModal({ open, onClose, onSelect, takenCards, currentValue, title }) {
  if (!open) return null;
  return (
    <div className="picker-backdrop">
      <div className="picker-panel">
        <div className="picker-head">
          <strong>{title}</strong>
          <button type="button" onClick={onClose}>×</button>
        </div>
        <div className="card-grid modal-grid">
          {deckList.map((card) => {
            const disabled = takenCards.has(card) && card !== currentValue;
            return (
              <button
                key={card}
                type="button"
                className={`card-button ${disabled ? 'disabled' : ''}`}
                disabled={disabled}
                onClick={() => onSelect(card)}
              >{formatCard(card)}</button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function HomeView() {
  const openRange = () => window.location.assign('?tool=range');
  const openEquity = () => window.location.assign('?tool=equity');

  const featureCards = [
    {
      label: 'Range Lab',
      title: '实时范围实验室',
      desc: '查看基准 GTO 范围并根据对手画像自动调整。',
      action: { label: '进入', handler: openRange }
    },
    {
      label: '胜率计算工具',
      title: '德州计算器',
      desc: '手牌 + 公共牌一键估算，对标 WeChat「德州计算器」。',
      action: { label: '进入', handler: openEquity }
    },
    {
      label: 'Reports',
      title: 'Hand History 工具',
      desc: '整理关键牌局并生成复盘报告（开发中）。'
    }
  ];

  return (
    <div className="site">
      <nav className="top-nav">
        <div className="brand">KISHPOKER</div>
        <ul>
          <li><a href="?tool=range">Range Lab</a></li>
          <li><a href="?tool=equity">胜率计算</a></li>
          <li><a href="https://github.com/jtxdavid7-lgtm/kishpre" target="_blank" rel="noreferrer">GitHub</a></li>
        </ul>
      </nav>

      <header className="hero">
        <div>
          <p className="eyebrow">欢迎来到</p>
          <h1>kishpoker</h1>
          <p>一个围绕精确决策打造的扑克实验室：范围工具、胜率计算以及更多模块将在此聚合。</p>
        </div>
        <div className="cta-row">
          <button type="button" className="primary" onClick={openRange}>打开 Range Lab</button>
          <button type="button" className="secondary" onClick={openEquity}>胜率计算工具</button>
        </div>
      </header>

      <section>
        <div className="section-title">
          <h2>工具入口</h2>
          <span className="subtext">点击打开对应模块</span>
        </div>
        <div className="feature-grid">
          {featureCards.map((feature) => (
            <article key={feature.label} className="feature-card">
              <span>{feature.label}</span>
              <h3>{feature.title}</h3>
              <p>{feature.desc}</p>
              {feature.action && (
                <button type="button" className="card-link" onClick={feature.action.handler}>
                  {feature.action.label}
                </button>
              )}
            </article>
          ))}
        </div>
      </section>
    </div>
  );
}

function App() {
  const search = typeof window !== 'undefined' ? window.location.search : '';
  const params = new URLSearchParams(search);
  const tool = params.get('tool');

  if (tool === 'range') return <RangeLabView />;
  if (tool === 'equity') return <EquityView />;
  return <HomeView />;
}

export default App;
