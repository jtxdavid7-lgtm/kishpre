import { useEffect, useMemo, useState } from 'react';
import {
  GTO_FORMAL_CONFIG,
  GTO_POSITION_CODE,
  GTO_POSITION_ORDER,
  describeGtoAction
} from '../data/gtoFormal.js';
import {
  findActionTransition,
  findSeatDecisionNode,
  getGtoDecisionTrail,
  loadGtoFlopAggregateManifest,
  loadGtoFlopAggregateNode,
  loadGtoFlopManifest,
  loadGtoFlopNode,
  loadGtoPreflopIndex,
  loadGtoPreflopNode,
  strategyGradient,
  summarizeStrategy
} from '../lib/gtoQueryEngine.js';
import './GtoQueryExplorer.css';

const POSTFLOP_PREFLOP_LINE = Object.freeze([
  { actor: 3, action: 'Fold' },
  { actor: 2, action: 'Fold' },
  { actor: 1, action: 'Fold' },
  { actor: 0, action: 'Raise 2.5 bb' },
  { actor: 9, action: 'Fold' },
  { actor: 8, action: 'Call' }
]);
const STREET_LABELS = Object.freeze({ 1: '翻牌', 2: '转牌', 3: '河牌' });
const CARD_RANKS = Object.freeze(['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A']);
const CARD_SUITS = Object.freeze([
  { key: 'h', symbol: '♥' },
  { key: 's', symbol: '♠' },
  { key: 'd', symbol: '♦' },
  { key: 'c', symbol: '♣' }
]);

function describeCard(code) {
  const suit = CARD_SUITS[code % 4];
  return { rank: CARD_RANKS[Math.floor(code / 4)], ...suit };
}

function hasPostflopPackForSelection(index, nodeId, terminalSelection) {
  if (!index || !terminalSelection || terminalSelection.nodeId !== nodeId) return false;
  const line = getGtoDecisionTrail(index, nodeId).map((entry) => ({
    actor: entry.node.actor,
    action: entry.node.id === terminalSelection.nodeId ? terminalSelection.action : entry.selectedAction
  }));
  return line.length === POSTFLOP_PREFLOP_LINE.length && line.every((entry, position) => (
    entry.actor === POSTFLOP_PREFLOP_LINE[position].actor &&
    entry.action === POSTFLOP_PREFLOP_LINE[position].action
  ));
}

function formatFrequency(value) {
  if (value > 0 && value < 0.001) return '<0.1%';
  return `${(value * 100).toFixed(1)}%`;
}

function formatEv(value) {
  if (!Number.isFinite(value)) return '—';
  return `${Number(value.toFixed(3))}bb`;
}

function SolutionLibrary({ open, onClose }) {
  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = (event) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  if (!open) return null;
  const filters = [
    ['牌局', '现金桌'], ['人数', '6-max'], ['有效筹码', '100bb'],
    ['开池尺寸', '2.5bb'], ['抽水', 'GG R&C'], ['Flat Drop', '1.5bb']
  ];

  return (
    <div className="gto-library-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <section className="gto-library-dialog" role="dialog" aria-modal="true" aria-labelledby="gto-library-title">
        <header>
          <div><span>完整静态策略数据集</span><h2 id="gto-library-title">解决方案库</h2></div>
          <button type="button" aria-label="关闭解决方案库" onClick={onClose}>×</button>
        </header>
        <p className="gto-library-intro">当前数据包包含 RocketSolver 正式解中的全部 2,588 个翻前决策节点。策略按数据块在需要时读取，不在浏览器或服务器实时求解。</p>
        <div className="gto-library-filters">
          {filters.map(([label, value]) => (
            <fieldset key={label}><legend>{label}</legend><div><button type="button" className="active">{value}</button></div></fieldset>
          ))}
        </div>
        <div className="gto-solution-list">
          <header><strong>可用方案</strong><span>1 个正式方案</span></header>
          <button type="button" className="gto-solution-row active" onClick={onClose}>
            <span>★</span><strong>100bb</strong><span>GG R&C · 6-max</span><span>2,588 个翻前节点</span><span>2.5x</span><b>正在使用</b>
          </button>
        </div>
        <footer><span>数据方式</span> 完整求解文件留在本机；网站只发布经过结构、组合数、频率闭合与有限数值校验的静态数据。</footer>
      </section>
    </div>
  );
}

function ActionSummary({ action, frequency }) {
  return (
    <article className="gto-action-summary" style={{ '--action-color': action.color }}>
      <span>{action.label}</span>
      <strong>{formatFrequency(frequency)}</strong>
      <small>节点范围加权频率</small>
    </article>
  );
}

function StrategyMatrix({ node, selectedHand, onSelect }) {
  return (
    <div className="gto-matrix-scroll">
      <div className="gto-matrix" aria-label="正式策略矩阵">
        {node.matrix.map((hand) => (
          <button
            type="button"
            key={hand.label}
            className={`gto-matrix-cell${selectedHand?.label === hand.label ? ' active' : ''}${hand.reach <= 1e-9 ? ' unreachable' : ''}`}
            style={{ background: strategyGradient(hand.actions, node.actionDescriptors) }}
            aria-pressed={selectedHand?.label === hand.label}
            aria-label={`${hand.label}，${node.actionDescriptors.map((action) => `${action.shortLabel} ${formatFrequency(hand.actions[action.key])}`).join('，')}`}
            onClick={() => onSelect(hand)}
          ><b>{hand.label}</b></button>
        ))}
      </div>
    </div>
  );
}

function HandDetail({ hand, actions, solutionScope = '翻前' }) {
  if (!hand) return null;
  const unreachable = hand.reach <= 1e-9;
  return (
    <section className="gto-hand-detail">
      <header>
        <div><span>当前起手牌</span><strong>{hand.label}</strong></div>
        <div className="gto-hand-total-ev"><span>策略总 EV</span><b>{unreachable ? '不可达' : formatEv(hand.totalEv)}</b></div>
      </header>
      <div className="gto-hand-meta">
        <span>{hand.combinations} 个花色组合</span>
        <span>到达权重 {formatFrequency(hand.reach)}</span>
      </div>
      <div className="gto-frequency-list">
        {actions.map((action) => {
          const frequency = hand.actions[action.key] ?? 0;
          return (
            <div key={action.key}>
              <span><b>{action.label}</b><em>{unreachable ? '—' : formatFrequency(frequency)}</em><strong>EV {unreachable ? '—' : formatEv(hand.actionEvs[action.key])}</strong></span>
              <div><i style={{ width: `${frequency * 100}%`, background: action.color }} /></div>
            </div>
          );
        })}
      </div>
      <p>{unreachable ? '这类手牌在当前行动历史下没有到达权重，因此不把全零数组解释为策略。' : hand.note}</p>
      <small>EV 单位为大盲；数据来自离线冻结的{solutionScope}静态解。</small>
    </section>
  );
}

const FLOP_TEXTURE_LABELS = Object.freeze({
  unpaired: '非对子',
  paired: '对子面',
  trips: '三条面',
  rainbow: '彩虹',
  'two-tone': '双色',
  monotone: '单色',
  connected: '强连接',
  'semi-connected': '弱连接',
  disconnected: '不连接'
});

function BoardCards({ board }) {
  return (
    <span className="gto-report-board-cards">
      {board.map((code) => {
        const card = describeCard(code);
        return (
          <i className={`gto-board-card gto-board-card--mini gto-suit--${card.key}`} key={code}>
            <strong>{card.rank}</strong><span>{card.symbol}</span>
          </i>
        );
      })}
    </span>
  );
}

function FlopAggregateReport({ node, onOpenBoard }) {
  const [actionIndex, setActionIndex] = useState(0);
  const [pairedness, setPairedness] = useState('all');
  const [suitedness, setSuitedness] = useState('all');
  const [connectedness, setConnectedness] = useState('all');
  const [sortBy, setSortBy] = useState('frequency');
  const [selectedBoardId, setSelectedBoardId] = useState(node.boards[0]?.id ?? '');
  const selectedActionIndex = Math.min(actionIndex, node.actions.length - 1);

  const boards = useMemo(() => {
    const filtered = node.boards.filter((entry) => (
      (pairedness === 'all' || entry.texture.pairedness === pairedness) &&
      (suitedness === 'all' || entry.texture.suitedness === suitedness) &&
      (connectedness === 'all' || entry.texture.connectedness === connectedness)
    ));
    return [...filtered].sort((left, right) => {
      if (sortBy === 'ev') return (right.ev ?? -Infinity) - (left.ev ?? -Infinity);
      if (sortBy === 'high-card') {
        return right.texture.highRank - left.texture.highRank || left.id.localeCompare(right.id);
      }
      return right.frequencies[selectedActionIndex] - left.frequencies[selectedActionIndex];
    });
  }, [connectedness, node.boards, pairedness, selectedActionIndex, sortBy, suitedness]);
  const selectedBoard = node.boards.find((entry) => entry.id === selectedBoardId)
    ?? boards[0]
    ?? null;
  const selectedAction = describeGtoAction(node.actions[selectedActionIndex], node);

  return (
    <div className="gto-flop-report">
      <header className="gto-report-summary">
        <div>
          <span>完整翻牌聚合报告</span>
          <strong>{node.boards.length.toLocaleString()} 类同构翻牌 · 22,100 个实体翻牌</strong>
          <small>按牌面同构数与当前节点到达范围加权；不是简单平均。</small>
        </div>
        <div className="gto-report-action-pills">
          {node.actions.map((label, index) => {
            const action = describeGtoAction(label, node);
            return (
              <button
                type="button"
                className={index === selectedActionIndex ? 'active' : ''}
                key={label}
                style={{ '--action-color': action.color }}
                onClick={() => setActionIndex(index)}
              >
                <span>{action.shortLabel}</span>
                <strong>{formatFrequency(node.aggregate.frequencies[index])}</strong>
              </button>
            );
          })}
          <div><span>范围 EV</span><strong>{formatEv(node.aggregate.ev)}</strong></div>
        </div>
      </header>
      <div className="gto-report-filters">
        <label>配对
          <select value={pairedness} onChange={(event) => setPairedness(event.target.value)}>
            <option value="all">全部</option><option value="unpaired">非对子</option>
            <option value="paired">对子面</option><option value="trips">三条面</option>
          </select>
        </label>
        <label>花色
          <select value={suitedness} onChange={(event) => setSuitedness(event.target.value)}>
            <option value="all">全部</option><option value="rainbow">彩虹</option>
            <option value="two-tone">双色</option><option value="monotone">单色</option>
          </select>
        </label>
        <label>连接性
          <select value={connectedness} onChange={(event) => setConnectedness(event.target.value)}>
            <option value="all">全部</option><option value="connected">强连接</option>
            <option value="semi-connected">弱连接</option>
            <option value="disconnected">不连接</option>
          </select>
        </label>
        <label>排序
          <select value={sortBy} onChange={(event) => setSortBy(event.target.value)}>
            <option value="frequency">所选行动频率</option><option value="ev">范围 EV</option>
            <option value="high-card">最高牌</option>
          </select>
        </label>
        <span>筛选结果 {boards.length.toLocaleString()}</span>
      </div>
      <div className="gto-report-workspace">
        <div className="gto-report-table" role="list" aria-label="翻牌聚合结果">
          {boards.map((entry) => (
            <button
              type="button"
              role="listitem"
              className={entry.id === selectedBoard?.id ? 'active' : ''}
              key={entry.id}
              onClick={() => setSelectedBoardId(entry.id)}
            >
              <BoardCards board={entry.board} />
              <span>{FLOP_TEXTURE_LABELS[entry.texture.pairedness]} · {FLOP_TEXTURE_LABELS[entry.texture.suitedness]}</span>
              <b>{formatFrequency(entry.frequencies[selectedActionIndex])}</b>
              <em>{formatEv(entry.ev)}</em>
              <i style={{
                '--report-frequency': `${entry.frequencies[selectedActionIndex] * 100}%`,
                '--action-color': selectedAction.color
              }} />
            </button>
          ))}
        </div>
        <aside className="gto-report-detail">
          {selectedBoard && (
            <>
              <span>当前翻牌</span>
              <BoardCards board={selectedBoard.board} />
              <div className="gto-report-tags">
                <b>{FLOP_TEXTURE_LABELS[selectedBoard.texture.pairedness]}</b>
                <b>{FLOP_TEXTURE_LABELS[selectedBoard.texture.suitedness]}</b>
                <b>{FLOP_TEXTURE_LABELS[selectedBoard.texture.connectedness]}</b>
              </div>
              <dl>
                {node.actions.map((label, index) => (
                  <div key={label}><dt>{describeGtoAction(label, node).shortLabel}</dt>
                    <dd>{formatFrequency(selectedBoard.frequencies[index])}</dd></div>
                ))}
                <div><dt>范围 EV</dt><dd>{formatEv(selectedBoard.ev)}</dd></div>
                <div><dt>实体牌面权重</dt><dd>{selectedBoard.multiplicity}</dd></div>
              </dl>
              <button
                type="button"
                className="gto-report-open-strategy"
                onClick={() => onOpenBoard(selectedBoard.id)}
              >查看该翻牌的策略与 EV →</button>
              <p>频率按到达当前节点的完整双方范围计算；策略页读取该牌面的本地冻结解，不会实时调用求解器。</p>
            </>
          )}
        </aside>
      </div>
    </div>
  );
}

function PostflopActionTree({
  manifest,
  pack,
  index,
  nodeId,
  terminalSelection,
  onPackChange,
  onNodeChange,
  onAction,
  onBackToPreflop
}) {
  const node = index.nodes[nodeId];
  const trail = getGtoDecisionTrail(index, nodeId);
  const visibleCardCount = 3;

  return (
    <section className="gto-tree-shell gto-tree-shell--postflop">
      <button type="button" className="gto-solution-summary" onClick={onBackToPreflop}>
        <span>当前翻后场景</span><strong>BTN vs BB · 单加注底池</strong>
        <small>BTN 2.5bb · BB 跟注 · 底池 5.5bb</small><b>← 返回完整翻前树</b>
      </button>
      <div className="gto-tree-workspace">
        <div className="gto-tree-toolbar">
          <span>沿真实翻牌行动树逐步查看；1,755 类同构翻牌均为已经求解并冻结的静态数据。</span>
          <div>
            <button type="button" onClick={() => onNodeChange(node.parentId)} disabled={node.parentId === null}>← 返回一步</button>
            <button type="button" onClick={() => onNodeChange(index.rootId)}>重置翻后</button>
          </div>
        </div>
        <div className="gto-board-toolbar">
          <div><span>完整翻牌静态包</span><strong>{pack.label}</strong></div>
          <div className="gto-board-slots" aria-label="当前公共牌">
            {pack.board.map((cardCode, cardIndex) => {
              const card = describeCard(cardCode);
              return (
                <span className={`gto-board-card${cardIndex < visibleCardCount ? '' : ' future'}`} key={`${cardCode}-${cardIndex}`}>
                  <strong>{card.rank}</strong><i className={`gto-suit gto-suit--${card.key}`}>{card.symbol}</i>
                </span>
              );
            })}
          </div>
          <label className="gto-pack-select">
            <span>可用牌面</span>
            <select value={pack.id} onChange={(event) => onPackChange(event.target.value)}>
              {manifest.packs.map((candidate) => <option value={candidate.id} key={candidate.id}>{candidate.label}</option>)}
            </select>
          </label>
        </div>
        <div className="gto-postflop-path" aria-label="翻后行动历史">
          {trail.map((entry) => {
            const selectedAction = entry.node.id === terminalSelection?.nodeId
              ? terminalSelection.action
              : entry.selectedAction;
            return (
              <button
                type="button"
                key={entry.node.id}
                className={entry.node.id === nodeId ? 'current' : ''}
                onClick={() => onNodeChange(entry.node.id)}
              >
                <span>{STREET_LABELS[entry.node.street]} · {index.positions[entry.node.actor]}</span>
                <strong>{selectedAction ? describeGtoAction(selectedAction, entry.node).shortLabel : '当前决策'}</strong>
                <small>底池 {Number(entry.node.pot.toFixed(2))}bb</small>
              </button>
            );
          })}
        </div>
        <div className="gto-postflop-actions">
          <div><span>当前节点</span><strong>{STREET_LABELS[node.street]} · {index.positions[node.actor]}</strong><small>SPR {Number(node.spr.toFixed(1))}</small></div>
          <div>
            {node.actions.map((label) => {
              const action = describeGtoAction(label, node);
              return (
                <button
                  type="button"
                  key={label}
                  className={terminalSelection?.nodeId === node.id && terminalSelection.action === label ? 'selected' : ''}
                  style={{ '--action-color': action.color }}
                  onClick={() => onAction(node.id, label)}
                >{action.shortLabel}</button>
              );
            })}
          </div>
        </div>
        {terminalSelection && (
          <div className="gto-branch-notice"><span>分支结束</span><p>当前行动已经到达摊牌或弃牌终点；可返回任一历史节点改选行动。</p><button type="button" onClick={() => onNodeChange(terminalSelection.nodeId)}>返回终点前</button></div>
        )}
      </div>
    </section>
  );
}

function ActionTree({ index, nodeId, terminalSelection, postflopAvailable, onNodeChange, onAction, onOpenLibrary, onEnterPostflop }) {
  const node = index.nodes[nodeId];
  const trail = getGtoDecisionTrail(index, nodeId);
  const playerState = new Map(node.players.map((player) => [player.position, player]));

  const latestDecisionFor = (actor) => [...trail].reverse().find((entry) => entry.node.actor === actor);

  const selectSeat = (position) => {
    const target = findSeatDecisionNode(index, nodeId, GTO_POSITION_CODE[position]);
    if (target !== null) onNodeChange(target);
  };

  return (
    <section className="gto-tree-shell">
      <button type="button" className="gto-solution-summary" onClick={onOpenLibrary}>
        <span>当前方案</span><strong>GG R&C · 100bb</strong><small>6-max · 2.5x · Drop 1.5bb</small><b>完整翻前树 · 查看方案</b>
      </button>
      <div className="gto-tree-workspace">
        <div className="gto-tree-toolbar">
          <span>可直接点任意位置；此前未行动的位置自动补为弃牌</span>
          <div>
            <button type="button" onClick={() => onNodeChange(node.parentId)} disabled={node.parentId === null}>← 返回一步</button>
            <button type="button" onClick={() => onNodeChange(index.rootId)}>重置行动</button>
          </div>
        </div>
        <div className="gto-tree-scroll">
          <div className="gto-action-tree" aria-label="完整翻前行动树">
            {GTO_POSITION_ORDER.map((position) => {
              const actor = GTO_POSITION_CODE[position];
              const entry = latestDecisionFor(actor);
              const active = node.actor === actor;
              const player = playerState.get(actor);
              const terminalAction = terminalSelection && entry && terminalSelection.nodeId === entry.node.id
                ? terminalSelection.action
                : null;
              const selectedAction = terminalAction ?? entry?.selectedAction ?? null;
              return (
                <article className={`gto-tree-node gto-tree-node--seat${active ? ' hero' : ''}${player?.withCards === false ? ' folded' : ''}`} key={position}>
                  <button
                    type="button"
                    className="gto-seat-selector"
                    aria-label={`查看 ${position} 的决策节点`}
                    onClick={() => selectSeat(position)}
                  />
                  <header className="gto-seat-heading" aria-hidden="true">
                    <strong>{position}</strong><span>{Number(player?.stack ?? 100).toFixed((player?.stack ?? 100) % 1 ? 1 : 0)}</span>
                  </header>
                  {entry ? (
                    <div className="gto-tree-actions">
                      {entry.node.actions.map((label) => {
                        const action = describeGtoAction(label, entry.node);
                        return (
                          <button
                            type="button"
                            key={label}
                            className={selectedAction === label ? 'selected' : active ? 'available' : ''}
                            onClick={() => onAction(entry.node.id, label)}
                          >{action.shortLabel}</button>
                        );
                      })}
                    </div>
                  ) : <small>点击后自动补前位弃牌</small>}
                </article>
              );
            })}
            <button
              type="button"
              className={`gto-tree-node gto-tree-node--flop gto-tree-node--street${postflopAvailable ? ' active' : ''}`}
              disabled={!postflopAvailable}
              onClick={onEnterPostflop}
            >
              <header><strong>FLOP</strong><span>—</span></header>
              <small>{postflopAvailable ? '进入已求解翻后牌面' : terminalSelection ? '此翻前分支暂无翻后数据' : '完成翻前行动后进入'}</small>
            </button>
          </div>
        </div>
        <div className="gto-action-history" aria-label="当前行动历史">
          {trail.map((entry) => {
            const position = index.positions[entry.node.actor];
            return (
              <button type="button" key={entry.node.id} className={entry.node.id === nodeId ? 'current' : ''} onClick={() => onNodeChange(entry.node.id)}>
                {position}{entry.selectedAction ? ` · ${describeGtoAction(entry.selectedAction, entry.node).shortLabel}` : ' · 当前决策'}
              </button>
            );
          })}
        </div>
      </div>
    </section>
  );
}

export function GtoQueryExplorer() {
  const [mode, setMode] = useState('preflop');
  const [index, setIndex] = useState(null);
  const [nodeId, setNodeId] = useState(null);
  const [node, setNode] = useState(null);
  const [postflopManifest, setPostflopManifest] = useState(null);
  const [postflopPackId, setPostflopPackId] = useState('');
  const [postflopIndex, setPostflopIndex] = useState(null);
  const [postflopNodeId, setPostflopNodeId] = useState(null);
  const [postflopNode, setPostflopNode] = useState(null);
  const [flopAggregateManifest, setFlopAggregateManifest] = useState(null);
  const [flopAggregateNode, setFlopAggregateNode] = useState(null);
  const [studyView, setStudyView] = useState('strategy');
  const [postflopTerminalSelection, setPostflopTerminalSelection] = useState(null);
  const [selectedLabel, setSelectedLabel] = useState('AKs');
  const [terminalSelection, setTerminalSelection] = useState(null);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [postflopLoading, setPostflopLoading] = useState(false);
  const [error, setError] = useState('');
  const [postflopError, setPostflopError] = useState('');

  useEffect(() => {
    let cancelled = false;
    loadGtoPreflopIndex()
      .then((loadedIndex) => {
        if (cancelled) return;
        setIndex(loadedIndex);
        setNodeId(loadedIndex.rootId);
      })
      .catch((reason) => {
        if (!cancelled) setError(reason.message);
      });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    loadGtoFlopManifest()
      .then((manifest) => {
        if (cancelled) return;
        const preferredPack = manifest.packs.find((pack) => (
          pack.texture?.highRank === 14 &&
          pack.texture?.pairedness === 'unpaired' &&
          pack.texture?.suitedness === 'rainbow' &&
          pack.board.some((card) => Math.floor(card / 4) === 0) &&
          pack.board.some((card) => Math.floor(card / 4) === 5)
        )) ?? manifest.packs[0];
        setPostflopManifest(manifest);
        setPostflopIndex(manifest);
        setPostflopNodeId(manifest.rootId);
        setPostflopPackId((current) => current || preferredPack.id);
      })
      .catch((reason) => {
        if (!cancelled) setPostflopError(reason.message);
      });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    loadGtoFlopAggregateManifest()
      .then((manifest) => {
        if (!cancelled) setFlopAggregateManifest(manifest);
      })
      .catch(() => {
        // The report becomes available only after the full 1,755-flop batch is validated.
      });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!index || nodeId === null) return undefined;
    let cancelled = false;
    loadGtoPreflopNode(index, nodeId)
      .then((loadedNode) => {
        if (cancelled) return;
        setNode(loadedNode);
        setLoading(false);
      })
      .catch((reason) => {
        if (!cancelled) {
          setError(reason.message);
          setLoading(false);
        }
      });
    return () => { cancelled = true; };
  }, [index, nodeId]);

  useEffect(() => {
    if (
      mode !== 'postflop' ||
      !postflopIndex ||
      !postflopPackId ||
      postflopNodeId === null
    ) return undefined;
    let cancelled = false;
    loadGtoFlopNode(postflopIndex, postflopPackId, postflopNodeId)
      .then((loadedNode) => {
        if (cancelled) return;
        setPostflopNode(loadedNode);
        setPostflopLoading(false);
      })
      .catch((reason) => {
        if (!cancelled) {
          setPostflopError(reason.message);
          setPostflopLoading(false);
        }
      });
    return () => { cancelled = true; };
  }, [mode, postflopIndex, postflopNodeId, postflopPackId]);

  useEffect(() => {
    if (
      studyView !== 'flop-report' ||
      !flopAggregateManifest ||
      !postflopNode ||
      postflopNode.street !== 1
    ) {
      return undefined;
    }
    const metadata = flopAggregateManifest.nodes.find((candidate) => (
      candidate.key === postflopNode.key ||
      (
        candidate.actor === postflopNode.actor &&
        Math.abs(candidate.pot - postflopNode.pot) < 0.001 &&
        JSON.stringify(candidate.actions) === JSON.stringify(postflopNode.actions)
      )
    ));
    if (!metadata) {
      return undefined;
    }
    let cancelled = false;
    loadGtoFlopAggregateNode(metadata)
      .then((loadedNode) => {
        if (!cancelled) setFlopAggregateNode(loadedNode);
      })
      .catch(() => {
        if (!cancelled) setFlopAggregateNode(null);
      });
    return () => { cancelled = true; };
  }, [flopAggregateManifest, postflopNode, studyView]);

  const changeNode = (nextNodeId) => {
    if (!index || nextNodeId === null || !index.nodes[nextNodeId]) return;
    if (nextNodeId !== nodeId) setLoading(true);
    setNodeId(nextNodeId);
    setSelectedLabel('AKs');
    setTerminalSelection(null);
  };

  const chooseAction = (decisionNodeId, actionLabel) => {
    if (!index) return;
    const transition = findActionTransition(index, decisionNodeId, actionLabel);
    if (!transition) return;
    if (transition.nextId !== null) {
      changeNode(transition.nextId);
      return;
    }
    setNodeId(decisionNodeId);
    setTerminalSelection({ nodeId: decisionNodeId, action: actionLabel });
  };

  const changePostflopNode = (nextNodeId) => {
    if (!postflopIndex || nextNodeId === null || !postflopIndex.nodes[nextNodeId]) return;
    if (nextNodeId !== postflopNodeId) setPostflopLoading(true);
    setPostflopNodeId(nextNodeId);
    setPostflopTerminalSelection(null);
  };

  const choosePostflopAction = (decisionNodeId, actionLabel) => {
    if (!postflopIndex) return;
    const transition = findActionTransition(postflopIndex, decisionNodeId, actionLabel);
    if (!transition) return;
    if (transition.nextId !== null) {
      changePostflopNode(transition.nextId);
      return;
    }
    setPostflopNodeId(decisionNodeId);
    setPostflopTerminalSelection({ nodeId: decisionNodeId, action: actionLabel });
  };

  const changePostflopPack = (nextPackId) => {
    if (nextPackId === postflopPackId) return;
    setPostflopLoading(true);
    setPostflopError('');
    setPostflopNode(null);
    setPostflopPackId(nextPackId);
  };

  const openAggregateBoard = (nextPackId) => {
    changePostflopPack(nextPackId);
    setStudyView('strategy');
  };

  const postflopAvailable = Boolean(
    postflopManifest?.packs.length && hasPostflopPackForSelection(index, nodeId, terminalSelection)
  );
  const activeNode = mode === 'postflop' ? postflopNode : node;
  const activeLoading = mode === 'postflop' ? postflopLoading : loading;
  const activeError = mode === 'postflop' ? postflopError : error;
  const activePack = postflopManifest?.packs.find((pack) => pack.id === postflopPackId) ?? null;
  const flopReportAvailable = Boolean(
    mode === 'postflop' && activeNode?.street === 1 && flopAggregateManifest
  );
  const showFlopReport = flopReportAvailable && studyView === 'flop-report';
  const activeFlopAggregateNode = flopAggregateNode && activeNode && (
    flopAggregateNode.key === activeNode.key ||
    (
      flopAggregateNode.actor === activeNode.actor &&
      Math.abs(flopAggregateNode.pot - activeNode.pot) < 0.001 &&
      JSON.stringify(flopAggregateNode.actions) === JSON.stringify(activeNode.actions)
    )
  ) ? flopAggregateNode : null;

  const summary = activeNode ? summarizeStrategy(activeNode) : {};
  const selectedHand = activeNode?.matrix.find((hand) => hand.label === selectedLabel) ?? activeNode?.matrix[0] ?? null;
  const actionGradient = activeNode?.actionDescriptors.reduce((parts, action, actionIndex) => {
    const previous = activeNode.actionDescriptors.slice(0, actionIndex).reduce((sum, item) => sum + (summary[item.key] ?? 0), 0) * 100;
    const end = previous + (summary[action.key] ?? 0) * 100;
    return [...parts, `${action.color} ${previous}%`, `${action.color} ${end}%`];
  }, []).join(', ') ?? '';

  return (
    <main className="gto-query">
      <section className="gto-query-hero">
        <div>
          <p className="eyebrow">GTO QUERY · STATIC SOLUTION EXPLORER</p>
          <h1>{mode === 'postflop' ? '沿翻牌行动树，查看每个节点频率与 EV' : '自由选择位置，从翻前进入已求解翻后牌面'}</h1>
          <p>{mode === 'postflop'
            ? '当前正式翻牌库覆盖 1,755 类同构翻牌及每个牌面的完整翻牌行动树；网页只按需读取压缩静态快照，不在浏览器或服务器实时求解。'
            : '点击任意位置或行动进入对应决策节点；此前未行动的位置会自动补为弃牌。完成受支持的翻前线路后，可直接进入对应翻后静态解。'}</p>
        </div>
        <div className="gto-snapshot-notice" role="note">
          <span>{mode === 'postflop' ? '完整翻牌 · 1,755 类牌面' : '已求解 · 2,588 个翻前节点'}</span><strong>GG R&C 6-max · 100bb</strong>
          <p>{mode === 'postflop'
            ? 'BTN vs BB 单加注底池；33% 下注、50% 加注，覆盖每个翻牌上的全部翻牌行动分支。转牌与河牌正式库仍在生成。'
            : '覆盖开池、跟注、3-bet、4-bet+ 与全下。5% cap 3bb；底池达到 30bb 时扣 1.5bb Flat Drop。'}</p>
        </div>
      </section>

      {mode === 'preflop' && index && nodeId !== null && (
        <ActionTree
          index={index}
          nodeId={nodeId}
          terminalSelection={terminalSelection}
          postflopAvailable={postflopAvailable}
          onNodeChange={changeNode}
          onAction={chooseAction}
          onOpenLibrary={() => setLibraryOpen(true)}
          onEnterPostflop={() => {
            setSelectedLabel('AKs');
            setPostflopLoading(true);
            setPostflopError('');
            setMode('postflop');
          }}
        />
      )}
      {mode === 'postflop' && postflopManifest && activePack && postflopIndex && postflopNodeId !== null && (
        <PostflopActionTree
          manifest={postflopManifest}
          pack={activePack}
          index={postflopIndex}
          nodeId={postflopNodeId}
          terminalSelection={postflopTerminalSelection}
          onPackChange={changePostflopPack}
          onNodeChange={changePostflopNode}
          onAction={choosePostflopAction}
          onBackToPreflop={() => setMode('preflop')}
        />
      )}

      <section className="gto-study-panel">
        {activeError ? (
          <div className="gto-unavailable"><span>数据加载失败</span><h3>无法读取{mode === 'postflop' ? '完整翻牌包' : '完整翻前快照'}</h3><p>{activeError}</p></div>
        ) : !activeNode ? (
          <div className="gto-unavailable"><span>正在读取</span><h3>加载{mode === 'postflop' ? '翻后静态策略' : '完整翻前策略'}</h3><p>首次进入会读取节点索引，随后只按需下载当前策略块。</p></div>
        ) : (
          <>
            <nav className="gto-study-tabs" aria-label="策略查看模式">
              <button
                type="button"
                className={showFlopReport ? '' : 'active'}
                onClick={() => setStudyView('strategy')}
              >策略 + EV</button>
              {flopReportAvailable && (
                <button
                  type="button"
                  className={showFlopReport ? 'active' : ''}
                  onClick={() => setStudyView('flop-report')}
                >翻牌聚合报告</button>
              )}
              <button type="button" disabled>范围对比</button>
              <button type="button" disabled>牌力拆解</button>
              <span>{activeNode.actorLabel} · 底池 {Number(activeNode.pot.toFixed(2))}bb · SPR {Number(activeNode.spr.toFixed(1))}{activeLoading ? ' · 读取中' : ''}</span>
            </nav>
            {showFlopReport ? (
              activeFlopAggregateNode
                ? <FlopAggregateReport node={activeFlopAggregateNode} onOpenBoard={openAggregateBoard} />
                : <div className="gto-report-loading">正在读取当前行动节点的完整翻牌聚合数据…</div>
            ) : (
              <div className="gto-study-grid" aria-busy={activeLoading}>
                <section className="gto-matrix-panel">
                  <header className="gto-matrix-heading">
                    <div><strong>起手牌矩阵</strong><small>点击任意手牌查看行动频率与 EV</small></div>
                    <div className="gto-legend">{activeNode.actionDescriptors.map((action) => <span key={action.key}><i style={{ background: action.color }} />{action.shortLabel}</span>)}</div>
                  </header>
                  <StrategyMatrix node={activeNode} selectedHand={selectedHand} onSelect={(hand) => setSelectedLabel(hand.label)} />
                </section>
                <aside className="gto-overview-panel">
                  <header><div><span>节点概览</span><strong>{activeNode.actorLabel} 的可选行动</strong></div><b className="gto-node-badge">{mode === 'postflop' ? '完整翻牌快照' : '完整快照'}</b></header>
                  <div className="gto-action-summaries">{activeNode.actionDescriptors.map((action) => <ActionSummary key={action.key} action={action} frequency={summary[action.key] ?? 0} />)}</div>
                  <div className="gto-range-bar" style={{ background: `linear-gradient(90deg, ${actionGradient})` }} aria-label="行动频率总览" />
                  <HandDetail
                    hand={selectedHand}
                    actions={activeNode.actionDescriptors}
                    solutionScope={mode === 'postflop' ? '翻牌' : '翻前'}
                  />
                </aside>
              </div>
            )}
            <footer className="gto-data-boundary">
              <div><span>数据版本</span><strong>{GTO_FORMAL_CONFIG.version}</strong></div>
              <div><span>{mode === 'postflop' ? '翻后决策节点' : '翻前决策节点'}</span><strong>{mode === 'postflop' ? postflopIndex.postflopDecisionNodes.toLocaleString() : GTO_FORMAL_CONFIG.preflopDecisionNodes.toLocaleString()}</strong></div>
              <div><span>求解状态</span><strong>已求解 · 静态快照</strong></div>
              <div><span>抽水模型</span><strong>{GTO_FORMAL_CONFIG.rake} · {GTO_FORMAL_CONFIG.flatDrop}</strong></div>
              <p><strong>覆盖范围：</strong>{mode === 'postflop'
                ? '完整覆盖 BTN 对 BB 单加注底池的 1,755 类同构翻牌及其全部翻牌行动分支；转牌与河牌不在本数据版本中。'
                : GTO_FORMAL_CONFIG.coverage} {GTO_FORMAL_CONFIG.licensing}</p>
            </footer>
          </>
        )}
      </section>
      <SolutionLibrary open={libraryOpen} onClose={() => setLibraryOpen(false)} />
    </main>
  );
}
