import { useEffect, useState } from 'react';
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
  loadGtoPreflopIndex,
  loadGtoPreflopNode,
  strategyGradient,
  summarizeStrategy
} from '../lib/gtoQueryEngine.js';
import './GtoQueryExplorer.css';

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

function HandDetail({ hand, actions }) {
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
      <small>EV 单位为大盲；数据来自离线冻结的完整翻前解。</small>
    </section>
  );
}

function ActionTree({ index, nodeId, terminalSelection, onNodeChange, onAction, onOpenLibrary }) {
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
            <article className="gto-tree-node gto-tree-node--flop">
              <header><strong>FLOP</strong><span>—</span></header>
              <small>{terminalSelection ? '当前翻前分支已经结束' : '完成翻前行动后进入'}</small>
            </article>
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
  const [index, setIndex] = useState(null);
  const [nodeId, setNodeId] = useState(null);
  const [node, setNode] = useState(null);
  const [selectedLabel, setSelectedLabel] = useState('AKs');
  const [terminalSelection, setTerminalSelection] = useState(null);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

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

  const summary = node ? summarizeStrategy(node) : {};
  const selectedHand = node?.matrix.find((hand) => hand.label === selectedLabel) ?? node?.matrix[0] ?? null;
  const actionGradient = node?.actionDescriptors.reduce((parts, action, actionIndex) => {
    const previous = node.actionDescriptors.slice(0, actionIndex).reduce((sum, item) => sum + (summary[item.key] ?? 0), 0) * 100;
    const end = previous + (summary[action.key] ?? 0) * 100;
    return [...parts, `${action.color} ${previous}%`, `${action.color} ${end}%`];
  }, []).join(', ') ?? '';

  return (
    <main className="gto-query">
      <section className="gto-query-hero">
        <div>
          <p className="eyebrow">GTO QUERY · COMPLETE PREFLOP TREE</p>
          <h1>自由选择位置，查看完整翻前策略</h1>
          <p>点击任意位置或行动进入对应决策节点；此前未行动的位置会自动补为弃牌。全部频率与 EV 来自本机冻结的 RocketSolver 正式解。</p>
        </div>
        <div className="gto-snapshot-notice" role="note">
          <span>已求解 · 2,588 个翻前节点</span><strong>GG R&C 6-max · 100bb</strong>
          <p>覆盖开池、跟注、3-bet、4-bet+ 与全下。5% cap 3bb；底池达到 30bb 时扣 1.5bb Flat Drop。</p>
        </div>
      </section>

      {index && nodeId !== null && (
        <ActionTree index={index} nodeId={nodeId} terminalSelection={terminalSelection} onNodeChange={changeNode} onAction={chooseAction} onOpenLibrary={() => setLibraryOpen(true)} />
      )}

      <section className="gto-study-panel">
        {error ? (
          <div className="gto-unavailable"><span>数据加载失败</span><h3>无法读取完整翻前快照</h3><p>{error}</p></div>
        ) : !node ? (
          <div className="gto-unavailable"><span>正在读取</span><h3>加载完整翻前策略</h3><p>首次进入会读取节点索引，随后只按需下载当前策略块。</p></div>
        ) : (
          <>
            <nav className="gto-study-tabs" aria-label="策略查看模式">
              <button type="button" className="active">策略 + EV</button>
              <button type="button" disabled>范围对比</button>
              <button type="button" disabled>牌力拆解</button>
              <span>{node.actorLabel} · 底池 {Number(node.pot.toFixed(2))}bb · SPR {Number(node.spr.toFixed(1))}{loading ? ' · 读取中' : ''}</span>
            </nav>
            <div className="gto-study-grid" aria-busy={loading}>
              <section className="gto-matrix-panel">
                <header className="gto-matrix-heading">
                  <div><strong>起手牌矩阵</strong><small>点击任意手牌查看行动频率与 EV</small></div>
                  <div className="gto-legend">{node.actionDescriptors.map((action) => <span key={action.key}><i style={{ background: action.color }} />{action.shortLabel}</span>)}</div>
                </header>
                <StrategyMatrix node={node} selectedHand={selectedHand} onSelect={(hand) => setSelectedLabel(hand.label)} />
              </section>
              <aside className="gto-overview-panel">
                <header><div><span>节点概览</span><strong>{node.actorLabel} 的可选行动</strong></div><b className="gto-node-badge">完整快照</b></header>
                <div className="gto-action-summaries">{node.actionDescriptors.map((action) => <ActionSummary key={action.key} action={action} frequency={summary[action.key] ?? 0} />)}</div>
                <div className="gto-range-bar" style={{ background: `linear-gradient(90deg, ${actionGradient})` }} aria-label="行动频率总览" />
                <HandDetail hand={selectedHand} actions={node.actionDescriptors} />
              </aside>
            </div>
            <footer className="gto-data-boundary">
              <div><span>数据版本</span><strong>{GTO_FORMAL_CONFIG.version}</strong></div>
              <div><span>翻前决策节点</span><strong>{GTO_FORMAL_CONFIG.preflopDecisionNodes.toLocaleString()}</strong></div>
              <div><span>求解状态</span><strong>已求解 · 静态快照</strong></div>
              <div><span>抽水模型</span><strong>{GTO_FORMAL_CONFIG.rake} · {GTO_FORMAL_CONFIG.flatDrop}</strong></div>
              <p><strong>覆盖范围：</strong>{GTO_FORMAL_CONFIG.coverage} {GTO_FORMAL_CONFIG.licensing}</p>
            </footer>
          </>
        )}
      </section>
      <SolutionLibrary open={libraryOpen} onClose={() => setLibraryOpen(false)} />
    </main>
  );
}
