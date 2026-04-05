import { useMemo, useState } from 'react';
import { RangeMatrix } from './components/RangeMatrix.jsx';
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
const heroTemplate = () => Array(2).fill(null);
const boardTemplate = () => Array(5).fill(null);

const formatCard = (card) => {
  if (!card) return '--';
  const [rank, suit] = [card[0], card[1]];
  return `${rank}${SUIT_ICON[suit] ?? ''}`;
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
  const [heroCards, setHeroCards] = useState(() => heroTemplate());
  const [boardCards, setBoardCards] = useState(() => boardTemplate());
  const [activeSlot, setActiveSlot] = useState({ section: 'hero', index: 0 });
  const [opponents, setOpponents] = useState(1);
  const [iterations, setIterations] = useState(4000);
  const [result, setResult] = useState(null);
  const [status, setStatus] = useState('idle');

  const takenCards = new Set([...heroCards, ...boardCards].filter(Boolean));

  const updateSlot = (section, index, value) => {
    if (section === 'hero') {
      setHeroCards((prev) => {
        const next = [...prev];
        next[index] = value;
        return next;
      });
    } else {
      setBoardCards((prev) => {
        const next = [...prev];
        next[index] = value;
        return next;
      });
    }
  };

  const handleSlotClick = (section, index) => {
    const currentList = section === 'hero' ? heroCards : boardCards;
    if (currentList[index]) {
      updateSlot(section, index, null);
    }
    setActiveSlot({ section, index });
  };

  const advanceSlot = (section, listOverride) => {
    const list = listOverride ?? (section === 'hero' ? heroCards : boardCards);
    const emptyIndex = list.findIndex((card) => !card);
    if (emptyIndex >= 0) {
      setActiveSlot({ section, index: emptyIndex });
      return;
    }
    if (section === 'hero') {
      const boardEmpty = boardCards.findIndex((card) => !card);
      setActiveSlot({ section: 'board', index: boardEmpty >= 0 ? boardEmpty : 0 });
    }
  };

  const handleCardPick = (card) => {
    if (takenCards.has(card)) return;
    const { section, index } = activeSlot;
    const currentList = section === 'hero' ? heroCards : boardCards;
    const nextList = [...currentList];
    nextList[index] = card;
    updateSlot(section, index, card);
    advanceSlot(section, nextList);
  };

  const resetAll = () => {
    setHeroCards(heroTemplate());
    setBoardCards(boardTemplate());
    setResult(null);
    setActiveSlot({ section: 'hero', index: 0 });
  };

  const runSimulation = () => {
    if (heroCards.filter(Boolean).length !== 2) {
      setStatus('need-cards');
      return;
    }
    setStatus('running');
    setResult(null);
    setTimeout(() => {
      const sim = simulateEquity({
        heroCards,
        boardCards,
        opponents,
        iterations
      });
      setResult(sim);
      setStatus(sim.status === 'ok' ? 'done' : sim.status);
    }, 20);
  };

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
          <p className="subtext">选择你的手牌 / 公共牌，估算与 N 名对手对抗时的胜率。</p>
        </header>

        <div className="selection-group">
          <div>
            <h4>手牌</h4>
            <div className="card-slots">
              {heroCards.map((card, idx) => (
                <button
                  key={`hero-${idx}`}
                  type="button"
                  className={`card-slot ${activeSlot.section === 'hero' && activeSlot.index === idx ? 'active' : ''}`}
                  onClick={() => handleSlotClick('hero', idx)}
                >{formatCard(card)}</button>
              ))}
            </div>
          </div>

          <div>
            <h4>公共牌</h4>
            <div className="card-slots">
              {boardCards.map((card, idx) => (
                <button
                  key={`board-${idx}`}
                  type="button"
                  className={`card-slot ${activeSlot.section === 'board' && activeSlot.index === idx ? 'active' : ''}`}
                  onClick={() => handleSlotClick('board', idx)}
                >{formatCard(card)}</button>
              ))}
            </div>
          </div>
        </div>

        <div className="card-grid">
          {deckList.map((card) => (
            <button
              key={card}
              type="button"
              className={`card-button ${takenCards.has(card) ? 'disabled' : ''}`}
              disabled={takenCards.has(card)}
              onClick={() => handleCardPick(card)}
            >{formatCard(card)}</button>
          ))}
        </div>

        <div className="equity-controls">
          <label>
            <span>对手人数</span>
            <input
              type="range"
              min="1"
              max="6"
              value={opponents}
              onChange={(e) => setOpponents(Number(e.target.value))}
            />
            <strong>{opponents + 1} 人桌</strong>
          </label>

          <label>
            <span>模拟次数</span>
            <select value={iterations} onChange={(e) => setIterations(Number(e.target.value))}>
              <option value={2000}>2000 次</option>
              <option value={4000}>4000 次</option>
              <option value={8000}>8000 次</option>
            </select>
          </label>
        </div>

        <div className="equity-actions">
          <button type="button" className="primary" onClick={runSimulation}>开始计算</button>
          <button type="button" className="secondary" onClick={resetAll}>清空</button>
          <span className="status-text">
            {status === 'running' && '正在模拟...'}
            {status === 'need-cards' && '请先选好两张手牌'}
            {status === 'invalid' && '组合无效，请检查选择'}
            {status === 'done' && result && `已完成 ${result.iterations.toLocaleString()} 次模拟`}
          </span>
        </div>

        {result?.status === 'ok' && (
          <div className="equity-result">
            <div>
              <p>胜率</p>
              <strong>{(result.winPct * 100).toFixed(1)}%</strong>
            </div>
            <div>
              <p>平局</p>
              <strong>{(result.tiePct * 100).toFixed(1)}%</strong>
            </div>
            <div>
              <p>落后</p>
              <strong>{(result.losePct * 100).toFixed(1)}%</strong>
            </div>
          </div>
        )}
      </section>
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
