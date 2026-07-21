import { useMemo, useState } from 'react';
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

function CardFace({ card, fallback = '+' }) {
  if (!card) return <span className="gto-card-empty">{fallback}</span>;
  const suit = SUITS.find((item) => item.key === card[1]);
  return <><strong>{card[0]}</strong><span className={`gto-suit gto-suit--${card[1]}`}>{suit?.label}</span></>;
}

function ActionSummary({ action, frequency }) {
  return (
    <article className="gto-action-summary" style={{ '--action-color': action.color }}>
      <span><i aria-hidden="true" />{action.label}</span>
      <strong>{(frequency * 100).toFixed(1)}%</strong>
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
          >
            <b>{hand.label}</b>
          </button>
        ))}
      </div>
    </div>
  );
}

function HandDetail({ hand }) {
  if (!hand) return null;
  return (
    <aside className="gto-hand-detail">
      <header>
        <div><span>当前组合</span><strong>{hand.label}</strong></div>
        <small>{hand.combinations} 个花色组合</small>
      </header>
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
    </aside>
  );
}

export function GtoQueryExplorer() {
  const [street, setStreet] = useState('preflop');
  const [board, setBoard] = useState(() => [...GTO_DEMO_CONFIG.demoBoard]);
  const [pickerIndex, setPickerIndex] = useState(null);
  const [selectedLabel, setSelectedLabel] = useState('AKs');
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

  return (
    <main className="gto-query">
      <section className="gto-query-hero">
        <div>
          <p className="eyebrow">GTO QUERY · MVP FRAMEWORK</p>
          <h1>从行动节点，查到每一手牌的策略结构</h1>
          <p>选择牌局、位置、有效筹码、行动路径与公共牌，查看版本化策略快照。当前仅接入演示数据，用来验证完整查询流程。</p>
        </div>
        <div className="gto-demo-notice" role="note">
          <span>DEMO · 非求解结果</span>
          <strong>不要把当前频率当作 GTO 建议</strong>
          <p>数据为人工编写的产品演示内容，未经过 solver 求解，也不用于实时牌局辅助。</p>
        </div>
      </section>

      <section className="gto-query-layout">
        <aside className="gto-query-sidebar">
          <header><span>01</span><div><strong>牌局配置</strong><small>当前 MVP 支持范围</small></div></header>
          <div className="gto-config-grid">
            <label><span>牌局类型</span><select disabled value="cash"><option value="cash">NLH 现金桌</option></select></label>
            <label><span>人数</span><select disabled value="6max"><option value="6max">6-max</option></select></label>
            <label><span>Hero 位置</span><select disabled value="BTN"><option value="BTN">BTN</option></select></label>
            <label><span>对手位置</span><select disabled value="BB"><option value="BB">BB</option></select></label>
            <label><span>有效筹码</span><select disabled value="100"><option value="100">100bb</option></select></label>
            <label><span>翻前行动</span><select disabled value="srp"><option value="srp">BTN 2.5bb · BB 跟注</option></select></label>
          </div>

          <div className="gto-step-heading"><span>02</span><div><strong>街道与牌面</strong><small>按顺序进入决策节点</small></div></div>
          <div className="gto-street-tabs" role="tablist" aria-label="选择街道">
            {GTO_DEMO_NODES.map((node) => (
              <button
                type="button"
                role="tab"
                aria-selected={street === node.street}
                className={street === node.street ? 'active' : ''}
                key={node.street}
                onClick={() => chooseStreet(node.street)}
              >{node.label}</button>
            ))}
          </div>

          {boardCount > 0 && (
            <div className="gto-board-builder">
              <div className="gto-board-slots">
                {Array.from({ length: boardCount }, (_, index) => (
                  <button
                    type="button"
                    key={index}
                    className={`gto-board-card${pickerIndex === index ? ' active' : ''}`}
                    aria-label={`选择第 ${index + 1} 张公共牌`}
                    onClick={() => setPickerIndex(pickerIndex === index ? null : index)}
                  ><CardFace card={board[index]} /></button>
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
                        return (
                          <button
                            type="button"
                            key={card}
                            disabled={disabled}
                            className={`gto-suit--${suit.key}`}
                            aria-label={`${suit.name}${rank}`}
                            onClick={() => chooseCard(card)}
                          >{rank}{suit.label}</button>
                        );
                      })}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          <div className="gto-step-heading"><span>03</span><div><strong>行动路径</strong><small>{result.node.actor} 面临决策</small></div></div>
          <ol className="gto-action-path">
            {result.node.path.map((item, index) => <li key={item}><span>{index + 1}</span>{item}</li>)}
          </ol>
        </aside>

        <section className="gto-result-panel">
          <header className="gto-result-header">
            <div>
              <p className="eyebrow">策略结果 · {result.node.label}</p>
              <h2>{result.node.actor} 决策 · 底池 {result.node.potBb}bb</h2>
              <span>{formatBoard(result.node.board)}</span>
            </div>
            <span className="gto-demo-badge">演示数据</span>
          </header>

          {!result.available ? (
            <div className="gto-unavailable" role="status">
              <span>当前节点未覆盖</span>
              <h3>这个牌面没有策略快照</h3>
              <p>{result.reason} 查询器不会为缺失节点推测或生成频率。</p>
              <button type="button" onClick={resetDemo}>载入可用演示节点</button>
            </div>
          ) : (
            <>
              <div className="gto-action-summaries">
                {result.actions.map((action) => <ActionSummary key={action.key} action={action} frequency={summary[action.key] ?? 0} />)}
              </div>
              <div className="gto-result-body">
                <div className="gto-matrix-panel">
                  <div className="gto-matrix-heading">
                    <div><strong>起手牌矩阵</strong><small>点击任意格查看行动频率</small></div>
                    <div className="gto-legend">
                      {result.actions.map((action) => <span key={action.key}><i style={{ background: action.color }} />{action.shortLabel}</span>)}
                    </div>
                  </div>
                  <StrategyMatrix node={result.node} selectedHand={selectedHand} onSelect={(hand) => setSelectedLabel(hand.label)} />
                </div>
                <HandDetail hand={selectedHand} />
              </div>
            </>
          )}

          <footer className="gto-data-boundary">
            <div><span>数据版本</span><strong>{GTO_DEMO_CONFIG.version}</strong></div>
            <div><span>数据来源</span><strong>{GTO_DEMO_CONFIG.source}</strong></div>
            <div><span>求解状态</span><strong>未求解 · 仅演示</strong></div>
            <div><span>抽水模型</span><strong>{GTO_DEMO_CONFIG.rake}</strong></div>
            <p><strong>覆盖边界：</strong>{GTO_DEMO_CONFIG.coverage}。未来接入授权数据时，每个数据包都必须保留版本、树配置、抽水、下注尺度和授权来源。</p>
          </footer>
        </section>
      </section>
    </main>
  );
}
