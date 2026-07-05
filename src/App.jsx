import { useMemo, useRef, useState } from 'react';
import { RangeMatrix } from './components/RangeMatrix.jsx';
import { RangeEditor } from './components/RangeEditor.jsx';
import { BASE_RANGES } from './data/base';
import { PROFILES } from './data/profiles';
import { getRangePayload } from './lib/rangeEngine';
import { simulateEquity } from './lib/equityEngine';
import JSZip from 'jszip';
import {
  POSITIONS,
  exportSummaryCsv,
  parseGgHands,
  summarizeHeroResults
} from './lib/handHistoryAnalyzer';
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
const PICKER_RANKS = ['A','K','Q','J','T','9','8','7','6','5','4','3','2'];
const PICKER_SUITS = ['s', 'h', 'c', 'd'];
const FEATURE_BLUEPRINT = [
  { key: 'range', action: 'range' },
  { key: 'equity', action: 'equity' },
  { key: 'variance', action: 'variance' },
  { key: 'rng', action: 'download' },
  { key: 'reports', action: 'history' }
];
const RNG_DOWNLOAD_PATH = '/downloads/kish-rng-win-x64-0.1.1.zip';
const PERCENTILE_POINTS = [
  { key: 'p05', label: '5% 最差', z: -1.6448536269514722 },
  { key: 'p25', label: '25% 偏低', z: -0.674489750196082 },
  { key: 'p50', label: '50% 中位', z: 0 },
  { key: 'p75', label: '75% 偏高', z: 0.674489750196082 },
  { key: 'p95', label: '95% 最好', z: 1.6448536269514722 }
];

const HOMEPAGE_COPY = {
  zh: {
    hero: {
      eyebrow: '欢迎来到',
      title: 'kishpoker',
      desc: '一个围绕精确决策打造的扑克实验室：范围工具、胜率计算以及更多模块将在此聚合。',
      primaryCta: '打开 Range Lab',
      secondaryCta: '胜率计算工具',
      varianceCta: '波动计算器'
    },
    section: {
      title: '工具入口',
      subtitle: '点击打开对应模块'
    },
    features: {
      range: {
        label: 'Range Lab',
        title: '实时范围实验室',
        desc: '查看基准 GTO 范围并根据对手画像自动调整。'
      },
      equity: {
        label: '胜率计算工具',
        title: '德州计算器',
        desc: '手牌 + 公共牌一键估算。'
      },
      variance: {
        label: 'Variance',
        title: '波动计算器',
        desc: '估算在指定手数下的收益分布、破产概率与极端下行。'
      },
      rng: {
        label: '随机数插件',
        title: '牌桌随机数助手',
        desc: '下载 Windows 插件，在直播或桌边一键生成随机数。'
      },
      reports: {
        label: 'Reports',
        title: 'Hand History 工具',
        desc: '导入 GGPoker 手牌历史，查看基础盈亏、资金曲线和翻前数据。'
      }
    },
    actions: {
      range: '进入',
      equity: '进入',
      variance: '进入',
      history: '进入',
      download: '下载'
    }
  },
  en: {
    hero: {
      eyebrow: 'Welcome to',
      title: 'kishpoker',
      desc: 'A poker lab built around precise decisions—range tools, equity sims, and more modules coming soon.',
      primaryCta: 'Open Range Lab',
      secondaryCta: 'Run Equity Calculator',
      varianceCta: 'Variance Calculator'
    },
    section: {
      title: 'Toolbox',
      subtitle: 'Pick a module to launch'
    },
    features: {
      range: {
        label: 'Range Lab',
        title: 'Real-time Range Lab',
        desc: 'Check baseline GTO ranges and auto-adjust them by opponent profile.'
      },
      equity: {
        label: 'Equity Calculator',
        title: 'Hold’em odds tool',
        desc: 'Select hole cards or ranges plus the board and simulate equities instantly.'
      },
      variance: {
        label: 'Variance',
        title: 'Variance calculator',
        desc: 'Project expected value, sigma bands, and risk of ruin for a given sample size.'
      },
      rng: {
        label: 'RNG Plugin',
        title: 'Table-side RNG helper',
        desc: 'Download the Windows helper to generate quick random numbers mid-session.'
      },
      reports: {
        label: 'Reports',
        title: 'Hand-history builder',
        desc: 'Import GGPoker hand histories and review profit, curve, and preflop stats.'
      }
    },
    actions: {
      range: 'Launch',
      equity: 'Launch',
      variance: 'Launch',
      history: 'Launch',
      download: 'Download'
    }
  }
};
const LANGUAGE_LABELS = { zh: '简体中文', en: 'English' };
const emptyHand = () => Array(2).fill(null);
const boardTemplate = () => Array(5).fill(null);
const TOTAL_COMBOS = 1326;

const erf = (x) => {
  const sign = Math.sign(x);
  const absX = Math.abs(x);
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;
  const t = 1 / (1 + p * absX);
  const expComponent = Math.exp(-absX * absX);
  const poly = (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t;
  return sign * (1 - poly * expComponent);
};

const normalCdf = (x) => 0.5 * (1 + erf(x / Math.SQRT2));

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

async function readZipTexts(fileName, data, depth = 0) {
  if (depth > 2) return [];
  const zip = await JSZip.loadAsync(data);
  const entries = Object.values(zip.files).filter((entry) => !entry.dir);
  const chunks = [];
  for (const entry of entries) {
    const lower = entry.name.toLowerCase();
    if (lower.endsWith('.txt')) {
      chunks.push({
        name: `${fileName}/${entry.name}`,
        text: await entry.async('string')
      });
    } else if (lower.endsWith('.zip')) {
      const nested = await entry.async('arraybuffer');
      chunks.push(...await readZipTexts(`${fileName}/${entry.name}`, nested, depth + 1));
    }
  }
  return chunks;
}

function isZipPayload(name, data) {
  const lower = name.toLowerCase();
  const bytes = new Uint8Array(data, 0, Math.min(4, data.byteLength));
  return lower.endsWith('.zip') || (bytes[0] === 0x50 && bytes[1] === 0x4b);
}

async function readHistoryFiles(fileList) {
  const files = Array.from(fileList ?? []);
  const chunks = [];
  for (const file of files) {
    const name = file.webkitRelativePath || file.name;
    const data = await file.arrayBuffer();
    if (isZipPayload(name, data)) {
      chunks.push(...await readZipTexts(name, data));
    } else {
      chunks.push({ name, text: new TextDecoder('utf-8').decode(data) });
    }
  }
  return chunks;
}

function rankedPlayers(hands) {
  const counts = new Map();
  const auto = new Map();
  for (const hand of hands) {
    for (const name of hand.players.keys()) counts.set(name, (counts.get(name) ?? 0) + 1);
    for (const name of hand.heroCandidates) auto.set(name, (auto.get(name) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count, auto: auto.get(name) ?? 0 }))
    .sort((a, b) => b.auto - a.auto || b.count - a.count || a.name.localeCompare(b.name));
}

function downloadText(filename, content, type = 'text/csv;charset=utf-8') {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

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
          <button type="button" className="secondary" onClick={() => window.location.assign('?tool=variance')}>波动计算</button>
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
          <button type="button" className="secondary" onClick={() => window.location.assign('?tool=variance')}>波动计算</button>
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
              const rank = card ? card[0] : '--';
              const suit = card ? card[1] : null;
              if (card && suit) {
                classes.push('filled', `suit-${suit}`);
              }
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
                  <span className="card-face">
                    <span className="card-rank">{rank}</span>
                    <span className="card-pip">{suit ? SUIT_ICON[suit] : ''}</span>
                  </span>
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
                  <div className="card-slots player-hand">
                    {player.cards.map((card, slotIdx) => {
                      const classes = ['card-slot', 'player-slot'];
                      if (!card) {
                        classes.push('empty');
                      } else if (card[1]) {
                        classes.push('filled', `suit-${card[1]}`);
                      }
                      const rank = card ? card[0] : '--';
                      const suitGlyph = card ? SUIT_ICON[card[1]] : '';
                      return (
                        <button
                          key={`${player.id}-${slotIdx}`}
                          type="button"
                          className={classes.join(' ')}
                          onClick={() => openPicker({ type: 'player', playerId: player.id, index: slotIdx })}
                        >
                          <span className="card-face">
                            <span className="card-rank">{rank}</span>
                            <span className="card-pip">{suitGlyph}</span>
                          </span>
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
                      );
                    })}
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
          {PICKER_SUITS.flatMap((suit) => (
            PICKER_RANKS.map((rank) => {
              const card = `${rank}${suit}`;
              const disabled = takenCards.has(card) && card !== currentValue;
              const suitGlyph = SUIT_ICON[suit] ?? '';
              const suitClass = `suit-${suit}`;
              return (
                <button
                  key={card}
                  type="button"
                  className={`card-button ${suitClass} ${disabled ? 'disabled' : ''}`}
                  disabled={disabled}
                  onClick={() => onSelect(card)}
                  aria-label={`${rank}${suit}`}
                >
                  <span className="card-rank">{rank}</span>
                  <span className="card-pip">{suitGlyph}</span>
                </button>
              );
            })
          ))}
        </div>
      </div>
    </div>
  );
}

function VarianceView() {
  const [winrate, setWinrate] = useState(5);
  const [stdev, setStdev] = useState(80);
  const [hands, setHands] = useState(50000);
  const [bankroll, setBankroll] = useState(1000);
  const [bbValue, setBbValue] = useState(10);
  const [currencySymbol, setCurrencySymbol] = useState('¥');

  const parseNumber = (value, fallback = 0) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  };

  const symbol = currencySymbol?.trim() || '¥';

  const analysis = useMemo(() => {
    const safeHands = Math.max(parseNumber(hands, 0), 0);
    const safeWinrate = parseNumber(winrate, 0);
    const safeStd = Math.max(Math.abs(parseNumber(stdev, 0)), 0);
    const safeBankroll = Math.max(parseNumber(bankroll, 0), 0);
    const safeBbValue = Math.max(parseNumber(bbValue, 0), 0);

    const blocks = safeHands / 100;
    const expectedBb = safeWinrate * blocks;
    const sigmaBb = safeStd * Math.sqrt(blocks);
    const expectedCurrency = expectedBb * safeBbValue;
    const sigmaCurrency = sigmaBb * safeBbValue;

    const probabilityDown = sigmaBb > 0
      ? normalCdf(-expectedBb / sigmaBb)
      : expectedBb < 0 ? 1 : 0;

    const ruinProbability = sigmaBb > 0
      ? normalCdf((-safeBankroll - expectedBb) / sigmaBb)
      : expectedBb <= -safeBankroll ? 1 : 0;

    const buildBand = (multiplier) => {
      const lowerBb = expectedBb - multiplier * sigmaBb;
      const upperBb = expectedBb + multiplier * sigmaBb;
      return {
        lowerBb,
        upperBb,
        lowerCurrency: lowerBb * safeBbValue,
        upperCurrency: upperBb * safeBbValue
      };
    };

    const percentiles = PERCENTILE_POINTS.map((row) => {
      const bbPoint = expectedBb + row.z * sigmaBb;
      return {
        ...row,
        bb: bbPoint,
        currency: bbPoint * safeBbValue
      };
    });

    return {
      expectedBb,
      sigmaBb,
      expectedCurrency,
      sigmaCurrency,
      probabilityDown,
      ruinProbability,
      percentiles,
      hands: safeHands,
      winrate: safeWinrate,
      stdev: safeStd,
      bankroll: safeBankroll,
      bbValue: safeBbValue,
      band1: buildBand(1),
      band2: buildBand(2)
    };
  }, [hands, winrate, stdev, bankroll, bbValue]);

  const formatNumber = (value, digits = 0) => {
    if (!Number.isFinite(value)) return '—';
    return value.toLocaleString('en-US', {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits
    });
  };

  const formatBb = (value, digits = 0) => {
    if (!Number.isFinite(value)) return '—';
    const sign = value > 0 ? '+' : value < 0 ? '−' : '';
    const absValue = Math.abs(value);
    const formatted = absValue.toLocaleString('en-US', {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits
    });
    return sign ? `${sign}${formatted} bb` : `0 bb`;
  };

  const formatCurrency = (value, digits = 0, options = {}) => {
    if (!Number.isFinite(value)) return '—';
    const { signed = true } = options;
    const absValue = Math.abs(value);
    const formatted = absValue.toLocaleString('en-US', {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits
    });
    const sign = value > 0 ? (signed ? '+' : '') : value < 0 ? '−' : '';
    return sign ? `${sign}${symbol}${formatted}` : `${symbol}${formatted}`;
  };

  const formatPercent = (value) => {
    if (!Number.isFinite(value)) return '—';
    return `${(value * 100).toFixed(1)}%`;
  };

  const formatRange = (lower, upper, formatter) => `${formatter(lower)} ~ ${formatter(upper)}`;

  return (
    <div className="site">
      <nav className="top-nav">
        <div className="brand">KISHPOKER · 波动计算</div>
        <div className="cta-row">
          <button type="button" className="secondary" onClick={() => window.location.assign('/')}>主页</button>
          <button type="button" className="secondary" onClick={() => window.location.assign('?tool=range')}>Range Lab</button>
          <button type="button" className="secondary" onClick={() => window.location.assign('?tool=equity')}>胜率计算</button>
        </div>
      </nav>

      <section className="range-panel" style={{ marginTop: 0 }}>
        <header>
          <p className="eyebrow">Variance</p>
          <h2>德州扑克波动 & 下行风险</h2>
          <p className="subtext">参考 Primedope 计算逻辑，利用胜率与标准差估算指定手数下的收益分布与破产概率。</p>
        </header>

        <div className="controls variance-inputs">
          <label>
            <span>胜率 (bb / 100)</span>
            <input type="number" step="0.1" value={winrate} onChange={(e) => setWinrate(parseNumber(e.target.value, 0))} />
            <span className="input-note">常见范围 2~8 bb/100</span>
          </label>
          <label>
            <span>标准差 (bb / 100)</span>
            <input type="number" step="1" value={stdev} onChange={(e) => setStdev(parseNumber(e.target.value, 0))} />
            <span className="input-note">现金桌常见 70~120 bb/100</span>
          </label>
          <label>
            <span>样本手数</span>
            <input type="number" step="100" value={hands} onChange={(e) => setHands(parseNumber(e.target.value, 0))} />
            <span className="input-note">以 100 手牌为一个区块</span>
          </label>
          <label>
            <span>银行滚仓 (bb)</span>
            <input type="number" step="10" value={bankroll} onChange={(e) => setBankroll(parseNumber(e.target.value, 0))} />
            <span className="input-note">用大盲衡量的可承受下行</span>
          </label>
          <label>
            <span>大盲面值</span>
            <input type="number" step="1" value={bbValue} onChange={(e) => setBbValue(parseNumber(e.target.value, 0))} />
            <span className="input-note">换算货币：单个大盲的金额</span>
          </label>
          <label>
            <span>货币符号</span>
            <input type="text" maxLength={3} value={currencySymbol} onChange={(e) => setCurrencySymbol(e.target.value)} />
            <span className="input-note">例如 ¥ / ￥ / $</span>
          </label>
        </div>

        <section className="variance-summary">
          <div>
            <p>样本</p>
            <strong>{formatNumber(analysis.hands, 0)} 手牌</strong>
            <span className="input-note">胜率 {formatNumber(analysis.winrate, 1)} · σ {formatNumber(analysis.stdev, 0)} bb/100</span>
          </div>
          <div>
            <p>期望收益</p>
            <strong>{formatBb(analysis.expectedBb)}</strong>
            <span className="input-note">≈ {formatCurrency(analysis.expectedCurrency)}</span>
          </div>
          <div>
            <p>亏损概率</p>
            <strong>{formatPercent(analysis.probabilityDown)}</strong>
            <span className="input-note">结果 &lt; 0 bb</span>
          </div>
        </section>

        <section className="variance-grid">
          <article className="variance-card">
            <p>1σ 区间</p>
            <strong>{formatRange(analysis.band1.lowerBb, analysis.band1.upperBb, formatBb)}</strong>
            <span>≈ {formatRange(analysis.band1.lowerCurrency, analysis.band1.upperCurrency, formatCurrency)}</span>
          </article>
          <article className="variance-card">
            <p>2σ 区间</p>
            <strong>{formatRange(analysis.band2.lowerBb, analysis.band2.upperBb, formatBb)}</strong>
            <span>≈ {formatRange(analysis.band2.lowerCurrency, analysis.band2.upperCurrency, formatCurrency)}</span>
          </article>
          <article className="variance-card">
            <p>破产概率</p>
            <strong>{formatPercent(analysis.ruinProbability)}</strong>
            <span>结果 ≤ -{formatNumber(analysis.bankroll, 0)} bb</span>
          </article>
          <article className="variance-card">
            <p>货币标准差</p>
            <strong>±{formatCurrency(analysis.sigmaCurrency, 0, { signed: false })}</strong>
            <span>每个 σ ≈ {formatBb(analysis.sigmaBb)}</span>
          </article>
        </section>

        <section className="variance-table">
          <h4>分位数估算</h4>
          <table>
            <thead>
              <tr>
                <th>分位</th>
                <th>bb</th>
                <th>货币</th>
              </tr>
            </thead>
            <tbody>
              {analysis.percentiles.map((row) => (
                <tr key={row.key}>
                  <td>{row.label}</td>
                  <td>{formatBb(row.bb)}</td>
                  <td>{formatCurrency(row.currency)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="variance-footnote">假设收益满足近似正态分布（Primedope 同款模型）。</p>
        </section>
      </section>
    </div>
  );
}

function formatNumber(value, digits = 1) {
  if (!Number.isFinite(value)) return '-';
  return value.toLocaleString(undefined, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits
  });
}

function formatMoney(value, digits = 2) {
  if (!Number.isFinite(value)) return '-';
  return value.toFixed(digits);
}

function formatPercent(value, digits = 1) {
  if (!Number.isFinite(value)) return '-';
  return `${formatNumber(value, digits)}%`;
}

function statTone(value) {
  if (!Number.isFinite(value) || value === 0) return '';
  return value >= 0 ? 'win' : 'loss';
}

function wwsfTone(value) {
  if (!Number.isFinite(value)) return '';
  if (value > 52) return 'win';
  if (value < 48) return 'loss';
  return '';
}

function stakeLabel(stakes) {
  const bb = Number(String(stakes).split('/')[1]?.replace('$', ''));
  return bb ? `NL${Math.round(bb * 100)}` : stakes;
}

const HISTORY_CURVE_LINES = [
  { key: 'profitBB', label: '总盈亏', color: '#22c55e' },
  { key: 'beforeRakeBB', label: '水前盈亏', color: '#facc15' },
  { key: 'nonShowdownBB', label: '非摊牌', color: '#ef4444' },
  { key: 'showdownBB', label: '摊牌', color: '#38bdf8' }
];

function HistoryCurve({ data = [] }) {
  const [hoveredPoint, setHoveredPoint] = useState(null);
  if (data.length < 2) {
    return <div className="history-empty-chart">上传牌谱后生成资金曲线</div>;
  }
  const width = 760;
  const height = 300;
  const padLeft = 46;
  const padRight = 98;
  const padTop = 24;
  const padBottom = 48;
  const values = data.flatMap((point) => HISTORY_CURVE_LINES.map((line) => point[line.key] ?? 0));
  const minY = Math.min(0, ...values);
  const maxY = Math.max(0, ...values);
  const span = maxY - minY || 1;
  const x = (index) => padLeft + (index / (data.length - 1)) * (width - padLeft - padRight);
  const y = (value) => height - padBottom - ((value - minY) / span) * (height - padTop - padBottom);
  const zeroY = y(0);
  const hands = data.length;
  const xTicks = [0, Math.floor((hands - 1) * 0.25), Math.floor((hands - 1) * 0.5), Math.floor((hands - 1) * 0.75), hands - 1];
  const yTicks = [maxY, maxY - span * 0.25, maxY - span * 0.5, maxY - span * 0.75, minY];
  const hoverIndex = hoveredPoint?.index ?? null;
  const hoverData = hoverIndex == null ? null : data[hoverIndex];

  const updateHover = (event) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const svgX = ((event.clientX - rect.left) / rect.width) * width;
    const rawIndex = ((svgX - padLeft) / (width - padLeft - padRight)) * (hands - 1);
    const index = Math.max(0, Math.min(hands - 1, Math.round(rawIndex)));
    setHoveredPoint({
      index,
      clientX: event.clientX,
      clientY: event.clientY
    });
  };

  return (
    <div className="history-curve-wrap">
      <svg
        className="history-curve"
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label="资金曲线"
        onMouseMove={updateHover}
        onMouseLeave={() => setHoveredPoint(null)}
      >
        {yTicks.map((tick) => (
          <g key={tick.toFixed(3)}>
            <line x1={padLeft} y1={y(tick)} x2={width - padRight} y2={y(tick)} className="history-grid-line" />
            <text x={padLeft - 8} y={y(tick) + 4} textAnchor="end" className="history-axis-label">
              {formatNumber(tick, 0)}
            </text>
          </g>
        ))}
        {xTicks.map((tick) => (
          <text key={tick} x={x(tick)} y={height - 14} textAnchor="middle" className="history-axis-label">
            {data[tick]?.hand ?? tick + 1}
          </text>
        ))}
        <line x1={padLeft} y1={zeroY} x2={width - padRight} y2={zeroY} className="history-zero-line" />
        {HISTORY_CURVE_LINES.map((line, lineIndex) => {
          const path = data
            .map((point, index) => `${index === 0 ? 'M' : 'L'} ${x(index).toFixed(1)} ${y(point[line.key] ?? 0).toFixed(1)}`)
            .join(' ');
          const last = data[data.length - 1]?.[line.key] ?? 0;
          const bbPer100 = hands ? (last / hands) * 100 : 0;
          const labelY = Math.min(height - 42, Math.max(18, y(last) + (lineIndex - 1.5) * 11));
          return (
            <g key={line.key}>
              <path d={path} className="history-profit-line" style={{ stroke: line.color }} />
              <circle cx={x(data.length - 1)} cy={y(last)} r="3.5" className="history-profit-dot" style={{ fill: line.color }} />
              <text
                x={width - padRight + 8}
                y={labelY}
                className="history-line-end-label"
                style={{ fill: line.color }}
              >
                {formatNumber(bbPer100, 2)}
              </text>
            </g>
          );
        })}
        {hoverData && (
          <g>
            <line x1={x(hoverIndex)} y1={padTop} x2={x(hoverIndex)} y2={height - padBottom} className="history-hover-line" />
            {HISTORY_CURVE_LINES.map((line) => (
              <circle
                key={line.key}
                cx={x(hoverIndex)}
                cy={y(hoverData[line.key] ?? 0)}
                r="4"
                className="history-hover-dot"
                style={{ fill: line.color }}
              />
            ))}
          </g>
        )}
        <text x={padLeft} y={13} className="history-axis-title">盈利 (BB)</text>
        <text x={(width + padLeft - padRight) / 2} y={height - 2} textAnchor="middle" className="history-axis-title">手数</text>
      </svg>
      <div className="history-curve-footer">
        <div className="history-curve-legend">
          {HISTORY_CURVE_LINES.map((line) => (
            <span key={line.key}><i style={{ background: line.color }} />{line.label}</span>
          ))}
        </div>
      </div>
      {hoverData && (
        <div
          className="history-curve-tooltip"
          style={{ left: hoveredPoint.clientX + 12, top: hoveredPoint.clientY + 12 }}
        >
          <strong>第 {hoverData.hand.toLocaleString()} 手</strong>
          {HISTORY_CURVE_LINES.map((line) => {
            const total = hoverData[line.key] ?? 0;
            const bbPer100 = hoverData.hand ? (total / hoverData.hand) * 100 : 0;
            return (
              <span key={line.key} style={{ color: line.color }}>
                {line.label}: {formatNumber(total, 1)} BB / {formatNumber(bbPer100, 2)} bb/100
              </span>
            );
          })}
        </div>
      )}
    </div>
  );
}

function HistoryStatCard({ label, value, tone, size }) {
  const className = [
    'history-stat-card',
    tone ? `history-stat-card--${tone}` : '',
    size ? `history-stat-card--${size}` : ''
  ].filter(Boolean).join(' ');
  return (
    <article className={className}>
      <span>{label}</span>
      <strong>{value}</strong>
    </article>
  );
}

function HandHistoryView() {
  const fileInputRef = useRef(null);
  const [status, setStatus] = useState('idle');
  const [message, setMessage] = useState('');
  const [hands, setHands] = useState([]);
  const [fileMeta, setFileMeta] = useState(null);
  const [hero, setHero] = useState('');
  const [stakeFilter, setStakeFilter] = useState('all');
  const [positionFilter, setPositionFilter] = useState('all');
  const [startTp, setStartTp] = useState('0');
  const [endTp, setEndTp] = useState('0');

  const players = useMemo(() => rankedPlayers(hands), [hands]);
  const rawResults = useMemo(() => (
    hero ? hands.map((hand) => hand.getHeroResult(hero)).filter(Boolean) : []
  ), [hands, hero]);
  const stakeOptions = useMemo(() => [...new Set(rawResults.map((hand) => hand.stakes))].filter(Boolean), [rawResults]);
  const positionOptions = useMemo(() => (
    POSITIONS.filter((pos) => rawResults.some((hand) => hand.position === pos))
  ), [rawResults]);
  const filteredResults = useMemo(() => rawResults.filter((hand) => (
    (stakeFilter === 'all' || hand.stakes === stakeFilter)
    && (positionFilter === 'all' || hand.position === positionFilter)
  )), [rawResults, stakeFilter, positionFilter]);
  const summary = useMemo(() => summarizeHeroResults(filteredResults), [filteredResults]);
  const mainStake = stakeOptions[0] ? stakeLabel(stakeOptions[0]) : '-';
  const pvi = summary.totalRake ? ((Number(endTp) - Number(startTp)) / summary.totalRake) * 100 : 0;

  const handleFiles = async (files) => {
    setStatus('loading');
    setMessage('正在解析牌谱...');
    try {
      const chunks = await readHistoryFiles(files);
      const parsed = chunks.flatMap((chunk) => parseGgHands(chunk.text));
      const unique = new Map();
      for (const hand of parsed) unique.set(hand.id, hand);
      const nextHands = [...unique.values()];
      const nextPlayers = rankedPlayers(nextHands);
      setHands(nextHands);
      setFileMeta({
        files: chunks.length,
        hands: nextHands.length,
        duplicates: parsed.length - nextHands.length
      });
      setHero(nextPlayers[0]?.name ?? '');
      setStakeFilter('all');
      setPositionFilter('all');
      setStatus(nextHands.length ? 'ready' : 'empty');
      setMessage(nextHands.length ? '' : '没有识别到 GGPoker 手牌。');
    } catch (error) {
      setStatus('error');
      setMessage(error instanceof Error ? error.message : '解析失败');
    }
  };

  const exportCsv = () => {
    if (!filteredResults.length) return;
    downloadText(`kishpoker-${hero || 'hero'}-hands.csv`, exportSummaryCsv(filteredResults));
  };

  return (
    <div className="site">
      <nav className="top-nav">
        <div className="brand">KISHPOKER · Hand History</div>
        <div className="cta-row">
          <button type="button" className="secondary" onClick={() => window.location.assign('/')}>主页</button>
          <button type="button" className="secondary" onClick={() => window.location.assign('?tool=range')}>Range Lab</button>
          <button type="button" className="secondary" onClick={() => window.location.assign('?tool=variance')}>波动计算</button>
        </div>
      </nav>

      <section className="range-panel history-panel" style={{ marginTop: 0 }}>
        <header>
          <p className="eyebrow">GGPoker · Local parser</p>
          <h2>牌谱统计</h2>
          <p className="subtext">上传 GG 手牌历史，浏览器本地解析，不上传服务器。第一版支持基础盈亏、资金曲线、VPIP/PFR/3Bet、级别和位置筛选。</p>
        </header>

        <input
          ref={fileInputRef}
          type="file"
          multiple
          hidden
          onChange={(event) => {
            if (event.target.files?.length) handleFiles(event.target.files);
            event.target.value = '';
          }}
        />

        <section
          className="history-upload"
          onDragOver={(event) => {
            event.preventDefault();
          }}
          onDrop={(event) => {
            event.preventDefault();
            if (event.dataTransfer.files?.length) handleFiles(event.dataTransfer.files);
          }}
        >
          <div>
            <strong>{status === 'loading' ? '正在解析...' : '拖入或选择牌谱文件'}</strong>
            <span>支持 .txt 和 .zip。大文件会在你的电脑本地处理。</span>
          </div>
          <button type="button" className="primary" onClick={() => fileInputRef.current?.click()} disabled={status === 'loading'}>
            选择文件
          </button>
        </section>

        {message && <div className={`history-message history-message--${status}`}>{message}</div>}

        {hands.length > 0 && (
          <>
            <section className="history-controls">
              <label>
                <span>Hero</span>
                <select value={hero} onChange={(event) => setHero(event.target.value)}>
                  {players.map((player) => (
                    <option key={player.name} value={player.name}>
                      {player.name} · {player.count} hands{player.auto ? ' · auto' : ''}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>级别</span>
                <select value={stakeFilter} onChange={(event) => setStakeFilter(event.target.value)}>
                  <option value="all">全部</option>
                  {stakeOptions.map((stake) => <option key={stake} value={stake}>{stake}</option>)}
                </select>
              </label>
              <label>
                <span>位置</span>
                <select value={positionFilter} onChange={(event) => setPositionFilter(event.target.value)}>
                  <option value="all">全部</option>
                  {positionOptions.map((position) => <option key={position} value={position}>{position}</option>)}
                </select>
              </label>
              <button type="button" className="secondary" onClick={exportCsv} disabled={!filteredResults.length}>导出 CSV</button>
            </section>

            <section className="history-meta">
              <span>导入 {fileMeta?.files ?? 0} 个文本源</span>
              <span>识别 {fileMeta?.hands?.toLocaleString() ?? 0} 手牌</span>
              {!!fileMeta?.duplicates && <span>去重 {fileMeta.duplicates.toLocaleString()} 手牌</span>}
              <span>当前筛选 {filteredResults.length.toLocaleString()} 手牌</span>
            </section>

            <section className="history-pvi-controls">
              <label>
                <span>起始 TP</span>
                <input type="number" value={startTp} onChange={(event) => setStartTp(event.target.value)} />
              </label>
              <label>
                <span>终止 TP</span>
                <input type="number" value={endTp} onChange={(event) => setEndTp(event.target.value)} />
              </label>
            </section>

            <section className="history-stat-grid">
              <div className="history-stat-row history-stat-row--basic">
                <HistoryStatCard label="总手数" value={summary.totalHands.toLocaleString()} />
                <HistoryStatCard label="常驻级别" value={mainStake} />
                <HistoryStatCard label="PVI" value={formatPercent(pvi, 2)} />
              </div>
              <div className="history-stat-row history-stat-row--profit">
                <HistoryStatCard label="水后 $" value={formatMoney(summary.totalProfit)} tone={statTone(summary.totalProfit)} />
                <HistoryStatCard label="水前 $" value={formatMoney(summary.beforeRakeProfit)} tone={statTone(summary.beforeRakeProfit)} />
                <HistoryStatCard label="盈利 bb" value={formatNumber(summary.totalProfitBB, 1)} tone={statTone(summary.totalProfitBB)} />
                <HistoryStatCard label="水后百手" value={formatNumber(summary.bbPer100, 2)} tone={statTone(summary.bbPer100)} />
                <HistoryStatCard label="水前百手" value={formatNumber(summary.beforeRakeBBPer100, 2)} tone={statTone(summary.beforeRakeBBPer100)} />
              </div>
              <div className="history-stat-row history-stat-row--rake">
                <HistoryStatCard label="总抽水" value={formatMoney(summary.totalRake)} />
                <HistoryStatCard label="游戏抽水" value={formatMoney(summary.gameRake)} />
                <HistoryStatCard label="JP抽水" value={formatMoney(summary.totalJackpot)} />
                <HistoryStatCard label="总抽水百手" value={formatNumber(summary.rakeBBPer100, 2)} />
                <HistoryStatCard label="抽水百手" value={formatNumber(summary.gameRakeBBPer100, 2)} />
                <HistoryStatCard label="JP抽水百手" value={formatNumber(summary.jackpotRakeBBPer100, 2)} />
              </div>
              <div className="history-stat-row history-stat-row--preflop">
                <HistoryStatCard label="VPIP" value={formatPercent(summary.vpip, 1)} />
                <HistoryStatCard label="PFR" value={formatPercent(summary.pfr, 1)} />
                <HistoryStatCard label="3Bet" value={formatPercent(summary.threeBet, 1)} />
              </div>
              <div className="history-stat-row history-stat-row--showdown">
                <HistoryStatCard label="WTSD" value={formatPercent(summary.wtsd, 1)} size="large" />
                <HistoryStatCard label="WWSF" value={formatPercent(summary.wwsf, 1)} tone={wwsfTone(summary.wwsf)} size="large" />
                <HistoryStatCard label="W$SD" value={formatPercent(summary.wsd, 1)} size="large" />
              </div>
            </section>

            <section className="history-chart-card">
              <div className="history-chart-head">
                <h3>资金曲线</h3>
                <span>单位：bb</span>
              </div>
              <HistoryCurve data={summary.curve} />
            </section>

            <section className="history-breakdown">
              <div>
                <h4>位置分布</h4>
                {summary.positions.map((item) => (
                  <p key={item.label}><span>{item.label}</span><strong>{item.count}</strong></p>
                ))}
              </div>
              <div>
                <h4>级别分布</h4>
                {summary.stakes.map((item) => (
                  <p key={item.label}><span>{item.label}</span><strong>{item.count}</strong></p>
                ))}
              </div>
            </section>
          </>
        )}
      </section>
    </div>
  );
}


function HomeView() {
  const openRange = () => window.location.assign('?tool=range');
  const openEquity = () => window.location.assign('?tool=equity');
  const openVariance = () => window.location.assign('?tool=variance');
  const openHistory = () => window.location.assign('?tool=history');
  const downloadPlugin = () => {
    if (typeof window === 'undefined') return;
    window.open(RNG_DOWNLOAD_PATH, '_blank');
  };
  const [language, setLanguage] = useState(() => {
    if (typeof window === 'undefined') return 'zh';
    const params = new URLSearchParams(window.location.search);
    return params.get('lang') === 'en' ? 'en' : 'zh';
  });

  const copy = HOMEPAGE_COPY[language] ?? HOMEPAGE_COPY.zh;

  const handleLanguageChange = (next) => {
    setLanguage(next);
    if (typeof window !== 'undefined') {
      const params = new URLSearchParams(window.location.search);
      if (next === 'zh') {
        params.delete('lang');
      } else {
        params.set('lang', next);
      }
      const query = params.toString();
      const nextUrl = `${window.location.pathname}${query ? `?${query}` : ''}`;
      window.history.replaceState({}, '', nextUrl);
    }
  };

  const featureCards = FEATURE_BLUEPRINT.map((item) => {
    const meta = copy.features[item.key];
    const actionHandler = (() => {
      if (item.action === 'range') return openRange;
      if (item.action === 'equity') return openEquity;
      if (item.action === 'variance') return openVariance;
      if (item.action === 'history') return openHistory;
      if (item.action === 'download') return downloadPlugin;
      return null;
    })();
    return {
      key: item.key,
      ...meta,
      actionHandler,
      actionLabel: actionHandler ? copy.actions[item.action] : null
    };
  });

  return (
    <div className="site">
      <nav className="top-nav">
        <div className="brand">KISHPOKER</div>
        <div className="lang-switch">
          {Object.entries(LANGUAGE_LABELS).map(([code, label]) => (
            <button
              type="button"
              key={code}
              className={language === code ? 'active' : ''}
              onClick={() => handleLanguageChange(code)}
            >{label}</button>
          ))}
        </div>
      </nav>

      <header className="hero">
        <div>
          <p className="eyebrow">{copy.hero.eyebrow}</p>
          <h1>{copy.hero.title}</h1>
          <p>{copy.hero.desc}</p>
        </div>
        <div className="cta-row">
          <button type="button" className="primary" onClick={openRange}>{copy.hero.primaryCta}</button>
          <button type="button" className="secondary" onClick={openEquity}>{copy.hero.secondaryCta}</button>
          <button type="button" className="secondary" onClick={openVariance}>{copy.hero.varianceCta ?? 'Variance calculator'}</button>
        </div>
      </header>

      <section>
        <div className="section-title">
          <h2>{copy.section.title}</h2>
          <span className="subtext">{copy.section.subtitle}</span>
        </div>
        <div className="feature-grid">
          {featureCards.map((feature) => (
            <article key={feature.key} className="feature-card">
              <span>{feature.label}</span>
              <h3>{feature.title}</h3>
              <p>{feature.desc}</p>
              {feature.actionHandler && (
                <button type="button" className="card-link" onClick={feature.actionHandler}>
                  {feature.actionLabel}
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
  if (tool === 'variance') return <VarianceView />;
  if (tool === 'history') return <HandHistoryView />;
  return <HomeView />;
}

export default App;
