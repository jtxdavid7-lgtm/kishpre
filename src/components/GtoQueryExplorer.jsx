import { useEffect, useMemo, useState } from 'react';
import { GTO_DEMO_ACTIONS, GTO_DEMO_CONFIG, GTO_DEMO_NODES } from '../data/gtoDemo.js';
import {
  formatBoard,
  queryDemoStrategy,
  strategyGradient,
  summarizeDemoStrategy
} from '../lib/gtoQueryEngine.js';
import './GtoQueryExplorer.css';

const RANKS = ['A', 'K', 'Q', 'J', 'T', '9', '8', '7', '6', '5', '4', '3', '2'];
const SUITS = [
  { key: 's', label: '♠', name: '黑桃' },
  { key: 'h', label: '♥', name: '红桃' },
  { key: 'd', label: '♦', name: '方块' },
  { key: 'c', label: '♣', name: '梅花' }
];
const STREET_BOARD_COUNT = { preflop: 0, flop: 3, turn: 4, river: 5 };
const PREFLOP_SEATS = [
  { position: 'UTG', stack: '100', action: '弃牌' },
  { position: 'HJ', stack: '100', action: '弃牌' },
  { position: 'CO', stack: '100', action: '弃牌' },
  { position: 'BTN', stack: '100', action: '加注 2.5bb', hero: true },
  { position: 'SB', stack: '99.5', action: '弃牌' },
  { position: 'BB', stack: '99', action: '跟注' }
];

function CardFace({ card, fallback = '+' }) {
  if (!card) return <span className="gto-card-empty">{fallback}</span>;
  const suit = SUITS.find((item) => item.key === card[1]);
  return <><strong>{card[0]}</strong><span className={`gto-suit gto-suit--${card[1]}`}>{suit?.label}</span></>;
}
function SolutionLibrary({ open, onClose, onSelect }) {
  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = (event) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  if (!open) return null;
  const filterGroups = [
    { label: '牌局', values: ['现金桌', '锦标赛', 'Spin & Go'], active: '现金桌' },
    { label: '人数', values: ['单挑', '6-max', '8-max', '9-max'], active: '6-max' },
    { label: '有效筹码', values: ['300', '200', '150', '125', '100', '80', '60', '40', '20'], active: '100' },
    { label: '翻前结构', values: ['允许冷跟', '不允许冷跟', 'Ante', 'Straddle'], active: '允许冷跟' },
    { label: '开池尺度', values: ['2x', '2.25x', '2.5x', '3x'], active: '2.5x' },
    { label: '翻后尺度', values: ['单一尺度', '多尺度'], active: '单一尺度' }
  ];

  return (
    <div className="gto-library-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <section className="gto-library-dialog" role="dialog" aria-modal="true" aria-labelledby="gto-library-title">
        <header>
          <div><span>策略数据集</span><h2 id="gto-library-title">解决方案库</h2></div>
          <button type="button" aria-label="关闭解决方案库" onClick={onClose}>×</button>
        </header>
        <p className="gto-library-intro">先确定牌局规则和求解树，再进入行动节点。当前只有一个演示方案可用，其余选项用于展示未来的数据筛选结构。</p>
        <div className="gto-library-filters">
          {filterGroups.map((group) => (
            <fieldset key={group.label}>
              <legend>{group.label}</legend>
              <div>
                {group.values.map((value) => (
                  <button type="button" key={value} className={value === group.active ? 'active' : ''} disabled={value !== group.active}>{value}</button>
                ))}
              </div>
            </fieldset>
          ))}
        </div>
        <div className="gto-solution-list">
          <header><strong>可用方案</strong><span>1 个演示方案</span></header>
          <button type="button" className="gto-solution-row active" onClick={onSelect}>
            <span>★</span><strong>100bb</strong><span>6-max 现金桌</span><span>无抽水演示</span><span>2.5x</span><b>使用</b>
          </button>
          {[80, 60, 40].map((stack) => (
            <div className="gto-solution-row disabled" key={stack}>
              <span>☆</span><strong>{stack}bb</strong><span>6-max 现金桌</span><span>等待授权数据</span><span>—</span><b>不可用</b>
            </div>
          ))}
        </div>
        <footer><span>DEMO</span> 当前方案未经过 solver 求解，不能作为实战策略建议。</footer>
      </section>
    </div>
  );
}

function ActionSummary({ action, frequency }) {
  return (
    <article className="gto-action-summary" style={{ '--action-color': action.color }}>
      <span>{action.label}</span>
      <strong>{(frequency * 100).toFixed(1)}%</strong>
      <small>全范围加权频率</small>
    </article>
  );
}

function StrategyMatrix({ node, selectedHand, onSelect }) {
  return (
    <div className="gto-matrix-scroll">
      <div className="gto-matrix" aria-label="演示策略矩阵">
        {node.matrix.map((hand) => (
          <button
            type="button"
            key={hand.label}
            className={`gto-matrix-cell${selectedHand?.label === hand.label ? ' active' : ''}`}
            style={{ background: strategyGradient(hand.actions) }}
            aria-pressed={selectedHand?.label === hand.label}
            aria-label={`${hand.label}，${Object.entries(hand.actions).map(([key, value]) => `${GTO_DEMO_ACTIONS[key].shortLabel} ${(value * 100).toFixed(0)}%`).join('，')}`}
            onClick={() => onSelect(hand)}
          ><b>{hand.label}</b></button>
        ))}
      </div>
    </div>
  );
}

function HandDetail({ hand }) {
  if (!hand) return null;
  return (
    <section className="gto-hand-detail">
      <header><div><span>当前组合</span><strong>{hand.label}</strong></div><small>{hand.combinations} 个可用花色组合</small></header>
      <div className="gto-frequency-list">
        {Object.entries(hand.actions).map(([key, frequency]) => {
          const action = GTO_DEMO_ACTIONS[key];
          return (
            <div key={key}>
              <span>{action.label}<b>{(frequency * 100).toFixed(0)}%</b></span>
              <div><i style={{ width: `${frequency * 100}%`, background: action.color }} /></div>
            </div>
          );
        })}
      </div>
      <p>{hand.note}</p>
      <small>该频率仅用于验证界面与数据结构，不代表求解器建议。</small>
    </section>
  );
}

function ActionTree({ street, board, onStreetChange, onOpenLibrary }) {
  return (
    <section className="gto-tree-shell">
      <button type="button" className="gto-solution-summary" onClick={onOpenLibrary}>
        <span>当前方案</span>
        <strong>现金桌 · 100bb</strong>
        <small>6-max · 2.5x · 演示数据</small>
        <b>更换方案</b>
      </button>
      <div className="gto-tree-scroll">
        <div className="gto-action-tree" role="tablist" aria-label="行动树与街道">
          {PREFLOP_SEATS.map((seat) => (
            <div className={`gto-tree-node gto-tree-node--seat${seat.hero ? ' hero' : ''}`} key={seat.position}>
              <header><strong>{seat.position}</strong><span>{seat.stack}</span></header>
              <small>{seat.action}</small>
            </div>
          ))}
          {GTO_DEMO_NODES.map((node) => (
            <button
              type="button"
              role="tab"
              aria-selected={street === node.street}
              className={`gto-tree-node gto-tree-node--street${street === node.street ? ' active' : ''}`}
              key={node.street}
              onClick={() => onStreetChange(node.street)}
            >
              <header><strong>{node.label}</strong><span>{node.potBb}bb</span></header>
              <small>{node.street === 'preflop' ? 'BTN 决策' : formatBoard(board.slice(0, STREET_BOARD_COUNT[node.street]))}</small>
            </button>
          ))}
        </div>
      </div>
    </section>
  );
}

export function GtoQueryExplorer() {
  const [street, setStreet] = useState('preflop');
  const [board, setBoard] = useState(() => [...GTO_DEMO_CONFIG.demoBoard]);
  const [pickerIndex, setPickerIndex] = useState(null);
  const [selectedLabel, setSelectedLabel] = useState('AKs');
  const [libraryOpen, setLibraryOpen] = useState(false);
  const boardCount = STREET_BOARD_COUNT[street];
  const visibleBoard = board.slice(0, boardCount);
  const result = queryDemoStrategy({ street, board: visibleBoard });
  const summary = useMemo(() => summarizeDemoStrategy(result.node), [result.node]);
  const selectedHand = result.node.matrix.find((hand) => hand.label === selectedLabel) ?? result.node.matrix[0];
  const takenCards = new Set(board.filter(Boolean));

  const chooseStreet = (nextStreet) => {
    setStreet(nextStreet);
    setSelectedLabel('AKs');
    setPickerIndex(null);
  };

  const chooseCard = (card) => {
    if (pickerIndex === null) return;
    setBoard((current) => current.map((value, index) => (index === pickerIndex ? card : value)));
    setPickerIndex(null);
  };

  const resetDemo = () => {
    setBoard([...GTO_DEMO_CONFIG.demoBoard]);
    setSelectedLabel('AKs');
    setPickerIndex(null);
  };

  const actionGradient = result.actions.reduce((parts, action, index) => {
    const previous = result.actions.slice(0, index).reduce((sum, item) => sum + (summary[item.key] ?? 0), 0) * 100;
    const end = previous + (summary[action.key] ?? 0) * 100;
    return [...parts, `${action.color} ${previous}%`, `${action.color} ${end}%`];
  }, []).join(', ');

  return (
    <main className="gto-query">
      <section className="gto-query-hero">
        <div>
          <p className="eyebrow">GTO QUERY · MVP FRAMEWORK</p>
          <h1>沿着行动树，定位每一个策略节点</h1>
          <p>先选择牌局解决方案，再按位置、行动和公共牌逐步进入节点。当前只接入一条演示树，用于验证查询器交互。</p>
        </div>
        <div className="gto-demo-notice" role="note">
          <span>DEMO · 非求解结果</span>
          <strong>不要把当前频率当作 GTO 建议</strong>
          <p>数据为人工编写的产品演示内容，未经过 solver 求解，也不用于实时牌局辅助。</p>
        </div>
      </section>

      <ActionTree street={street} board={board} onStreetChange={chooseStreet} onOpenLibrary={() => setLibraryOpen(true)} />

      {boardCount > 0 && (
        <section className="gto-board-toolbar">
          <div><span>当前牌面</span><strong>{result.node.label} · {result.node.actor} 决策</strong></div>
          <div className="gto-board-slots">
            {Array.from({ length: boardCount }, (_, index) => (
              <button type="button" key={index} className={`gto-board-card${pickerIndex === index ? ' active' : ''}`} aria-label={`选择第 ${index + 1} 张公共牌`} onClick={() => setPickerIndex(pickerIndex === index ? null : index)}>
                <CardFace card={board[index]} />
              </button>
            ))}
          </div>
          <button type="button" className="gto-demo-reset" onClick={resetDemo}>恢复演示牌面</button>
          {pickerIndex !== null && (
            <div className="gto-card-picker" aria-label="公共牌选择器">
              {SUITS.map((suit) => (
                <div key={suit.key}>
                  {RANKS.map((rank) => {
                    const card = `${rank}${suit.key}`;
                    const disabled = takenCards.has(card) && board[pickerIndex] !== card;
                    return <button type="button" key={card} disabled={disabled} className={`gto-suit--${suit.key}`} aria-label={`${suit.name}${rank}`} onClick={() => chooseCard(card)}>{rank}{suit.label}</button>;
                  })}
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      <section className="gto-study-panel">
        <nav className="gto-study-tabs" aria-label="策略查看模式">
          <button type="button" className="active">策略 + 频率</button>
          <button type="button" disabled>范围对比</button>
          <button type="button" disabled>牌力拆解</button>
          <span>{result.node.actor} · 底池 {result.node.potBb}bb · {formatBoard(result.node.board)}</span>
        </nav>

        {!result.available ? (
          <div className="gto-unavailable" role="status">
            <span>当前节点未覆盖</span><h3>这个牌面没有策略快照</h3>
            <p>{result.reason} 查询器不会为缺失节点推测或生成频率。</p>
            <button type="button" onClick={resetDemo}>载入可用演示节点</button>
          </div>
        ) : (
          <div className="gto-study-grid">
            <section className="gto-matrix-panel">
              <header className="gto-matrix-heading">
                <div><strong>起手牌矩阵</strong><small>点击任意格查看该组合的行动频率</small></div>
                <div className="gto-legend">{result.actions.map((action) => <span key={action.key}><i style={{ background: action.color }} />{action.shortLabel}</span>)}</div>
              </header>
              <StrategyMatrix node={result.node} selectedHand={selectedHand} onSelect={(hand) => setSelectedLabel(hand.label)} />
            </section>

            <aside className="gto-overview-panel">
              <header><div><span>节点概览</span><strong>{result.node.actor} 的可选行动</strong></div><b className="gto-demo-badge">演示数据</b></header>
              <div className="gto-action-summaries">{result.actions.map((action) => <ActionSummary key={action.key} action={action} frequency={summary[action.key] ?? 0} />)}</div>
              <div className="gto-range-bar" style={{ background: `linear-gradient(90deg, ${actionGradient})` }} aria-label="行动频率总览" />
              <HandDetail hand={selectedHand} />
            </aside>
          </div>
        )}

        <footer className="gto-data-boundary">
          <div><span>数据版本</span><strong>{GTO_DEMO_CONFIG.version}</strong></div>
          <div><span>数据来源</span><strong>{GTO_DEMO_CONFIG.source}</strong></div>
          <div><span>求解状态</span><strong>未求解 · 仅演示</strong></div>
          <div><span>抽水模型</span><strong>{GTO_DEMO_CONFIG.rake}</strong></div>
          <p><strong>覆盖边界：</strong>{GTO_DEMO_CONFIG.coverage}。未来接入授权数据时，每个数据包都必须保留版本、树配置、抽水、下注尺度和授权来源。</p>
        </footer>
      </section>

      <SolutionLibrary open={libraryOpen} onClose={() => setLibraryOpen(false)} onSelect={() => {
        resetDemo();
        setStreet('preflop');
        setLibraryOpen(false);
      }} />
    </main>
  );
}
