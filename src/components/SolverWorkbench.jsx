import { useEffect, useMemo, useRef, useState } from 'react';
import { CardPickerModal } from './CardPickerModal.jsx';
import { RangeEditor } from './RangeEditor.jsx';
import {
  createSolverJob,
  getSolverHealth,
  getSolverJob,
  getSolverResult,
  listSolverJobs,
  retrySolverJob,
  solverExportUrl,
  stopSolverJob
} from '../lib/solverApi.js';
import {
  rangeMapToSolverText,
  solverTextToRangeMap,
  summarizeSolverRange
} from '../lib/solverRange.js';
import { childNodesForAction, sameHistory } from '../lib/solverNavigation.js';
import './SolverWorkbench.css';

const TREE_POLICY_ID =
  'flop25-75-turn75-150-river33-75-150-raise75-ai50-floor-v1';
const COMPANION_CDN_BASE_URL =
  'https://kish2note-d6ggxsz7b384cb278-1301236168.tcloudbaseapp.com/downloads';
const COMPANION_DOWNLOAD_URL = `${COMPANION_CDN_BASE_URL}/kishpoker-solver-companion-win-x64-0.1.5-setup.exe`;
const INSTALL_CONNECTION_TIMEOUT_MS = 3 * 60 * 1000;
const FIRST_VISIT_PREVIEW = typeof window !== 'undefined'
  && new URLSearchParams(window.location.search).get('solverPreview') === 'first-visit';
const PRODUCTION_PREVIEW_BASE_URL = '/data/gto/gg-rnc-rb40-s000-production-preview-v1';
const PRODUCTION_PREVIEW_MANIFEST_URL = `${PRODUCTION_PREVIEW_BASE_URL}/manifest.json`;
const RANKS = ['A', 'K', 'Q', 'J', 'T', '9', '8', '7', '6', '5', '4', '3', '2'];
const SUIT_ICON = { s: '♠', h: '♥', d: '♦', c: '♣' };
const ACTION_COLORS = Object.freeze({
  check: '#2dd4bf',
  call: '#38bdf8',
  fold: '#64748b',
  allin: '#ef4444',
  aggressive: ['#facc15', '#fb923c', '#f43f5e', '#a855f7']
});
const TREE_SIZE_OPTIONS = Object.freeze({
  flop: [0.2, 0.25, 0.33, 0.5, 0.66, 0.75, 1, 1.25, 1.5],
  turn: [0.25, 0.33, 0.5, 0.66, 0.75, 1, 1.25, 1.5, 2],
  river: [0.25, 0.33, 0.5, 0.66, 0.75, 1, 1.25, 1.5, 2]
});
const TREE_PRESETS = Object.freeze({
  fast: { flop: [0.33], turn: [0.75], river: [0.75] },
  standard: { flop: [0.25, 0.75], turn: [0.75, 1.5], river: [0.33, 0.75, 1.5] },
  detailed: { flop: [0.25, 0.5, 0.75], turn: [0.5, 0.75, 1.5], river: [0.33, 0.75, 1.25, 2] }
});
const ACCURACY_PRESETS = Object.freeze([
  { id: 'preview', label: '快速预览', iterations: 32, target: 0 },
  { id: 'standard', label: '标准', iterations: 64, target: 0 },
  { id: 'fine', label: '精细', iterations: 128, target: 0.002 },
  { id: 'high', label: '高精度', iterations: 256, target: 0.001 }
]);
const ACTIVE_STATUSES = new Set(['queued', 'running', 'stopping']);
const STATUS_LABELS = {
  queued: '排队中',
  running: '求解中',
  stopping: '停止中',
  succeeded: '已完成',
  failed: '失败',
  stopped: '已停止',
  interrupted: '异常中断'
};

const ECONOMIC_PRESETS = {
  'gg-rnc-rb40': { rakeRate: 0.03, rakeCapBb: 1.8, flatDropThresholdBb: 30, flatDropAmountBb: 1.5 },
  'gg-rnc-full-rake': { rakeRate: 0.05, rakeCapBb: 3, flatDropThresholdBb: 30, flatDropAmountBb: 1.5 },
  'zero-rake': { rakeRate: 0, rakeCapBb: 0, flatDropThresholdBb: 0, flatDropAmountBb: 0 }
};

const DEFAULT_OOP_RANGE = {
  AA: { weight: 1 }, KK: { weight: 1 }, QQ: { weight: 1 }, AKs: { weight: 1 }
};
const DEFAULT_IP_RANGE = {
  JJ: { weight: 1 }, TT: { weight: 1 }, AKo: { weight: 1 }, AQs: { weight: 1 }
};

function bytesLabel(value) {
  if (!Number.isFinite(value) || value <= 0) return '—';
  const units = ['B', 'KiB', 'MiB', 'GiB'];
  let amount = value;
  let index = 0;
  while (amount >= 1024 && index < units.length - 1) {
    amount /= 1024;
    index += 1;
  }
  return `${amount.toFixed(index < 2 ? 0 : 2)} ${units[index]}`;
}

function percentage(value, digits = 1) {
  return Number.isFinite(value) ? `${(value * 100).toFixed(digits)}%` : '—';
}

function evLabel(value) {
  return Number.isFinite(value) ? `${value >= 0 ? '+' : ''}${value.toFixed(3)}bb` : '—';
}

function dateLabel(value) {
  if (!value) return '—';
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit'
  }).format(new Date(value));
}

function actionColor(action, index, actions = []) {
  const kind = action?.kind === 'all-in' ? 'allin' : action?.kind;
  if (ACTION_COLORS[kind]) return ACTION_COLORS[kind];
  if (kind === 'bet' || kind === 'raise') {
    const aggressive = actions
      .filter((candidate) => ['bet', 'raise'].includes(candidate.kind))
      .sort((left, right) => left.amountBb - right.amountBb);
    const sizeIndex = Math.max(0, aggressive.findIndex((candidate) => candidate.id === action.id));
    return ACTION_COLORS.aggressive[Math.min(sizeIndex, ACTION_COLORS.aggressive.length - 1)];
  }
  return ACTION_COLORS.aggressive[index % ACTION_COLORS.aggressive.length];
}

function actionPotFraction(action, node) {
  if (!action || !node || !Number.isFinite(action.amountBb) || action.amountBb <= 0) return null;
  const kind = action.kind === 'all-in' ? 'allin' : action.kind;
  if (kind === 'bet' || (kind === 'allin' && !(node.state.toCallBb > 0))) {
    return node.state.potBb > 0 ? action.amountBb / node.state.potBb : null;
  }
  if (kind === 'raise' || (kind === 'allin' && node.state.toCallBb > 0)) {
    const raiseAmount = action.amountBb - node.state.toCallBb;
    const potAfterCall = node.state.potBb + node.state.toCallBb;
    return raiseAmount > 0 && potAfterCall > 0 ? raiseAmount / potAfterCall : null;
  }
  return null;
}

function potFractionLabel(value) {
  if (!Number.isFinite(value)) return '';
  const percent = value * 100;
  return `${Number.isInteger(Math.round(percent * 10) / 10) ? percent.toFixed(0) : percent.toFixed(1)}% pot`;
}

function actionName(action, node = null) {
  if (!action) return '未知行动';
  let label = action.id;
  if (action.kind === 'check') label = '过牌';
  else if (action.kind === 'fold') label = '弃牌';
  else if (action.kind === 'call') label = `跟注 ${action.amountBb.toFixed(2)}bb`;
  else if (action.kind === 'all-in' || action.kind === 'allin') label = `All-in ${action.amountBb.toFixed(2)}bb`;
  else if (action.kind === 'bet') label = `下注 ${action.amountBb.toFixed(2)}bb`;
  else if (action.kind === 'raise') label = `加注 ${action.amountBb.toFixed(2)}bb`;
  const potLabel = potFractionLabel(actionPotFraction(action, node));
  return potLabel ? `${label}（${potLabel}）` : label;
}

function matrixGradient(hand, actions) {
  let cursor = 0;
  const stops = [];
  actions.forEach((action, index) => {
    const frequency = Math.max(0, Math.min(1, hand.actions[action.id] ?? 0));
    if (frequency <= 0) return;
    const next = Math.min(100, cursor + frequency * 100);
    stops.push(`${actionColor(action, index, actions)} ${cursor}% ${next}%`);
    cursor = next;
  });
  if (cursor < 100) stops.push(`#1b2433 ${cursor}% 100%`);
  return `linear-gradient(90deg, ${stops.join(', ')})`;
}

function ComboCards({ cards }) {
  return cards.map((card) => (
    <span key={card} className={`solver-combo-card suit-${card[1]}`}>
      {card[0]}{SUIT_ICON[card[1]]}
    </span>
  ));
}

function boardCardLabel(card) {
  return card ? `${card[0]}${SUIT_ICON[card[1]]}` : '下一街';
}

function handRetention(hand) {
  if (Number.isFinite(hand.retention)) return Math.max(0, Math.min(1, hand.retention));
  return hand.combinations > 0 ? Math.max(0, Math.min(1, hand.reach / hand.combinations)) : 0;
}

async function fileToRange(file) {
  if (/\.(bin|f32le)$/i.test(file.name)) {
    const buffer = await file.arrayBuffer();
    if (buffer.byteLength !== 1326 * 4) throw new Error('二进制范围必须正好包含 1326 个 float32');
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let index = 0; index < bytes.length; index += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
    }
    return { format: 'f32le-base64', data: btoa(binary), display: `已载入 1326-combo f32le（${bytes.length}B）` };
  }
  const value = (await file.text()).trim();
  if (!value) throw new Error('范围文件为空');
  return { format: 'text', value, map: solverTextToRangeMap(value), display: value };
}

function SolverRangeSelector({ label, value, onChange, onEdit, onError }) {
  const inputRef = useRef(null);
  const isBinary = value.format === 'f32le-base64';
  const summary = value.map ? summarizeSolverRange(value.map) : null;
  const labels = value.map ? Object.keys(value.map) : [];
  return (
    <section className="solver-range-field">
      <header>
        <span>{label}</span>
        <small>支持 solver 文本或 1326-combo f32le</small>
      </header>
      <button type="button" className="solver-range-overview" onClick={onEdit}>
        <span>
          <b>{isBinary ? '1326-combo 范围' : summary ? `覆盖 ${(summary.coverage * 100).toFixed(1)}%` : '已导入 solver 文本'}</b>
          <small>{isBinary ? value.display : summary ? `${summary.cells} 格 · ${summary.combos.toFixed(1)} combos` : '打开矩阵将重新选择范围'}</small>
        </span>
        <em>打开 13×13 矩阵</em>
      </button>
      {!isBinary && labels.length > 0 && (
        <div className="solver-range-chips">
          {labels.slice(0, 12).map((hand) => <span key={hand}>{hand}</span>)}
          {labels.length > 12 && <span>+{labels.length - 12}</span>}
        </div>
      )}
      <div className="solver-range-actions">
        <button type="button" onClick={onEdit}>选择范围</button>
        <button type="button" onClick={() => inputRef.current?.click()}>导入范围</button>
      </div>
      <input
        ref={inputRef}
        type="file"
        accept=".txt,.range,.bin,.f32le"
        hidden
        onChange={async (event) => {
          const file = event.target.files?.[0];
          if (!file) return;
          try {
            onChange(await fileToRange(file));
          } catch (cause) {
            onError?.(cause.message);
          }
          event.target.value = '';
        }}
      />
    </section>
  );
}

function StatusPanel({ job }) {
  const progress = job?.progress ?? {};
  const resources = job?.resources ?? {};
  return (
    <section className="solver-status-panel">
      <header>
        <div>
          <span className={`solver-status solver-status--${job?.status ?? 'idle'}`}>
            {job ? STATUS_LABELS[job.status] : '尚未启动'}
          </span>
          <h2>{job ? `任务 ${job.id.slice(0, 18)}` : '等待求解任务'}</h2>
        </div>
        <strong>{Number(progress.percent ?? 0).toFixed(1)}%</strong>
      </header>
      <div className="solver-progress" aria-label="求解进度">
        <i style={{ width: `${Math.max(0, Math.min(100, progress.percent ?? 0))}%` }} />
      </div>
      <div className="solver-metrics">
        <div><span>迭代</span><strong>{progress.iteration ?? 0} / {progress.totalIterations ?? '—'}</strong></div>
        <div><span>Exploitability</span><strong>{percentage(progress.exploitabilityPotFraction, 4)}</strong></div>
        <div><span>CPU</span><strong>{Number.isFinite(resources.cpuPercent) ? `${resources.cpuPercent.toFixed(0)}%` : '—'}</strong></div>
        <div><span>当前内存</span><strong>{bytesLabel(resources.workingSetBytes)}</strong></div>
        <div><span>峰值内存</span><strong>{bytesLabel(resources.peakWorkingSetBytes)}</strong></div>
        <div><span>阶段</span><strong>{job?.phase ?? 'idle'}</strong></div>
      </div>
      {job?.error && <div className="solver-error" role="alert"><b>{job.error.code}</b><span>{job.error.message}</span></div>}
    </section>
  );
}

function ResultWorkspace({ result, selectedHand, onSelectHand, onSelectNode, onChooseRunout, eyebrow = '已验证输出' }) {
  const node = result.selectedNode;
  const actions = node.actions;
  const chosen = selectedHand || node.matrix.find((hand) => hand.reach > 0) || node.matrix[0];
  const [pendingSelection, setPendingSelection] = useState(null);
  const pendingAction = pendingSelection?.nodeId === node.id ? pendingSelection.action : null;
  const pendingChildren = pendingAction
    ? childNodesForAction(result.nodes, node, pendingAction)
    : [];
  const parentNode = node.history.length === 0
    ? null
    : result.nodes.find((candidate) => {
        if (!sameHistory(candidate.history, node.history.slice(0, -1))) return false;
        const previousBoard = node.history.at(-1)?.currentBoard ?? [];
        return candidate.currentBoard?.join(',') === previousBoard.join(',');
      });

  const followAction = (action) => {
    const children = childNodesForAction(result.nodes, node, action);
    const reachesNextStreet = children.some(
      (candidate) => candidate.currentBoardText.length > node.currentBoardText.length
    );
    if (children.length === 1 && !reachesNextStreet) {
      void onSelectNode(children[0].id);
      return;
    }
    setPendingSelection({ nodeId: node.id, action });
  };
  return (
    <section className="solver-result-shell">
      <header className="solver-result-heading">
        <div>
          <span>{eyebrow} · {node.currentBoardText.map(boardCardLabel).join(' ')}</span>
          <h2>{node.street.toUpperCase()} · {node.actor} 决策</h2>
          <p>范围 EV {evLabel(node.aggregate.totalEv)} · 节点 reach {node.aggregate.reach.toFixed(2)}</p>
        </div>
        <div className="solver-result-actions">
          {actions.map((action, index) => (
            <span key={action.id} style={{ '--action-color': actionColor(action, index, actions) }}>
              <i />{actionName(action, node)} <b>{percentage(node.aggregate.actions[action.id])}</b>
            </span>
          ))}
        </div>
      </header>
      <div className="solver-result-grid">
        <section className="solver-matrix-panel">
          <header className="solver-matrix-legend">
            <span>格子填充高度 = 从翻后起点保留到当前节点的比例</span>
            <b>根节点 100%</b>
          </header>
          <div className="solver-matrix" role="grid" aria-label="13 乘 13 手牌矩阵">
            <span className="solver-matrix-corner" />
            {RANKS.map((rank) => <b className="solver-matrix-axis" key={`c-${rank}`}>{rank}</b>)}
            {RANKS.map((rank, row) => (
              <div className="solver-matrix-row" key={rank}>
                <b className="solver-matrix-axis">{rank}</b>
                {node.matrix.slice(row * 13, row * 13 + 13).map((hand) => (
                  <button
                    type="button"
                    role="gridcell"
                    key={hand.label}
                    className={`${chosen?.label === hand.label ? 'active' : ''}${hand.reach <= 0 ? ' empty' : ''}`}
                    title={`${hand.label} · EV ${evLabel(hand.totalEv)} · 保留 ${percentage(handRetention(hand))}`}
                    onClick={() => onSelectHand(hand)}
                  >
                    <strong>{hand.label}</strong>
                    <small>{hand.reach > 0 ? evLabel(hand.totalEv) : '—'}</small>
                    <i
                      className="solver-matrix-fill"
                      style={{
                        height: `${handRetention(hand) * 100}%`,
                        background: matrixGradient(hand, actions)
                      }}
                    />
                  </button>
                ))}
              </div>
            ))}
          </div>
        </section>
        <aside className="solver-hand-detail">
          <span>当前手牌</span>
          <h3>{chosen.label}</h3>
          <dl>
            <div><dt>范围权重</dt><dd>{chosen.reach.toFixed(3)}</dd></div>
            <div><dt>从起点保留</dt><dd>{percentage(handRetention(chosen))}</dd></div>
            <div><dt>总 EV</dt><dd>{evLabel(chosen.totalEv)}</dd></div>
            <div><dt>可用组合</dt><dd>{chosen.combinations}</dd></div>
          </dl>
          <div className="solver-hand-actions">
            {actions.map((action, index) => (
              <div key={action.id}>
                <header><span><i style={{ background: actionColor(action, index, actions) }} />{actionName(action, node)}</span><b>{percentage(chosen.actions[action.id])}</b></header>
                <div><i style={{ width: `${Math.max(0, Math.min(100, (chosen.actions[action.id] ?? 0) * 100))}%`, background: actionColor(action, index, actions) }} /></div>
                <small>行动 EV {evLabel(chosen.actionEvs[action.id])}</small>
              </div>
            ))}
          </div>
          <section className="solver-combo-detail">
            <header>
              <span>具体花色组合</span>
              <b>{chosen.combos?.filter((combo) => combo.reach > 0).length ?? 0} 个在范围内</b>
            </header>
            <div className="solver-combo-list">
              {(chosen.combos ?? []).map((combo) => (
                <article key={combo.index} className={combo.reach > 0 ? '' : 'inactive'}>
                  <header>
                    <strong><ComboCards cards={combo.cards} /></strong>
                    <b>{combo.reach > 0 ? evLabel(combo.totalEv) : '不在范围'}</b>
                  </header>
                  {combo.reach > 0 && (
                    <div className="solver-combo-actions">
                      {actions.map((action, index) => (
                        <span key={action.id} title={`${actionName(action, node)} · 行动 EV ${evLabel(combo.actionEvs[action.id])}`}>
                          <i style={{ background: actionColor(action, index, actions) }} />
                          {percentage(combo.actions[action.id])}
                        </span>
                      ))}
                    </div>
                  )}
                </article>
              ))}
            </div>
          </section>
        </aside>
      </div>
      <section className="solver-line-browser">
        <header>
          <div>
            <span>按牌桌顺序查看策略</span>
            <h3>{node.street.toUpperCase()} · 轮到 {node.actor}</h3>
            <p>{node.currentBoardText.map(boardCardLabel).join('  ')} · 底池 {node.state.potBb.toFixed(2)}bb</p>
          </div>
          {parentNode && <button type="button" className="solver-line-back" onClick={() => void onSelectNode(parentNode.id)}>← 返回上一步</button>}
        </header>
        <div className="solver-line-actions">
          {actions.map((action, index) => {
            const children = childNodesForAction(result.nodes, node, action);
            return (
              <button type="button" key={action.id} onClick={() => followAction(action)} style={{ '--action-color': actionColor(action, index, actions) }}>
                <i />
                <span><b>{node.actor} · {actionName(action, node)}</b><small>点击查看后续策略</small></span>
                <strong>{percentage(node.aggregate.actions[action.id])}</strong>
                {children.length > 1 && <em>{children.length} 张出牌</em>}
              </button>
            );
          })}
        </div>
        {pendingAction && (
          <div className="solver-runout-choices">
            <header><span>{actionName(pendingAction, node)}之后</span><b>{pendingChildren.length > 0 ? '选择下一张公共牌' : '这条行动已结束牌局'}</b></header>
            {pendingChildren.map((candidate) => {
              const nextCard = candidate.currentBoardText[node.currentBoardText.length];
              return (
                <button type="button" key={candidate.id} className={`suit-${nextCard?.[1] ?? ''}`} onClick={() => void onSelectNode(candidate.id)}>
                  {boardCardLabel(nextCard)}
                  <small>进入 {candidate.street.toUpperCase()}</small>
                </button>
              );
            })}
            {pendingChildren.some((candidate) => candidate.currentBoardText.length > node.currentBoardText.length) && node.street !== 'river' && (
              <button
                type="button"
                className="solver-runout-picker"
                onClick={() => onChooseRunout({
                  action: pendingAction,
                  node,
                  index: node.street === 'flop' ? 0 : 1
                })}
              >
                ＋ 选择其他{node.street === 'flop' ? '转牌' : '河牌'}
                <small>重新计算这张牌</small>
              </button>
            )}
          </div>
        )}
        <details className="solver-advanced-nodes">
          <summary>高级：查看全部 {result.nodes.length} 个内部节点</summary>
          <nav aria-label="全部求解节点">
            {result.nodes.map((candidate) => (
              <button type="button" key={candidate.id} className={candidate.id === node.id ? 'active' : ''} onClick={() => void onSelectNode(candidate.id)}>
                <span>#{candidate.id} · {candidate.street} · {candidate.actor}</span>
                <small>{candidate.history.at(-1)?.id ?? '根节点'} · {candidate.state.potBb.toFixed(2)}bb</small>
              </button>
            ))}
          </nav>
        </details>
      </section>
    </section>
  );
}

export function SolverWorkbench() {
  const [health, setHealth] = useState(() => (FIRST_VISIT_PREVIEW ? { status: 'offline' } : null));
  const [jobs, setJobs] = useState([]);
  const [activeJob, setActiveJob] = useState(null);
  const [result, setResult] = useState(null);
  const [selectedHand, setSelectedHand] = useState(null);
  const [loading, setLoading] = useState(() => !FIRST_VISIT_PREVIEW);
  const [error, setError] = useState('');
  const [pickerTarget, setPickerTarget] = useState(null);
  const [pendingRunoutNavigation, setPendingRunoutNavigation] = useState(null);
  const [rangeEditorTarget, setRangeEditorTarget] = useState(null);
  const [tutorialOpen, setTutorialOpen] = useState(false);
  const [installWatching, setInstallWatching] = useState(false);
  const installStartedAtRef = useRef(0);
  const [previewManifest, setPreviewManifest] = useState(null);
  const [previewSampleId, setPreviewSampleId] = useState('');
  const [previewPayload, setPreviewPayload] = useState(null);
  const [previewNodeId, setPreviewNodeId] = useState(null);
  const [previewSelectedHand, setPreviewSelectedHand] = useState(null);
  const [previewLoading, setPreviewLoading] = useState(true);
  const [previewError, setPreviewError] = useState('');
  const [form, setForm] = useState({
    boardCards: ['As', 'Kh', '9c'],
    runoutCards: [null, null],
    potBb: 17.5,
    effectiveStackBb: 92,
    oopRange: { format: 'text', value: rangeMapToSolverText(DEFAULT_OOP_RANGE), map: DEFAULT_OOP_RANGE },
    ipRange: { format: 'text', value: rangeMapToSolverText(DEFAULT_IP_RANGE), map: DEFAULT_IP_RANGE },
    economicModel: 'gg-rnc-rb40',
    ...ECONOMIC_PRESETS['gg-rnc-rb40'],
    maxIterations: 64,
    targetExploitabilityPotFraction: 0,
    treeBetSizes: TREE_PRESETS.standard,
    raisePotAfterCallFraction: 0.75,
    allInRemainingStackFraction: 0.5,
    exportStreets: 'flop-turn-river',
    turnCardLimit: 1,
    riverCardLimit: 1
  });
  const activeJobId = activeJob?.id;
  const activeJobStatus = activeJob?.status;
  const activePreviewSample = useMemo(
    () => previewManifest?.samples?.find((sample) => sample.id === previewSampleId) ?? null,
    [previewManifest, previewSampleId]
  );
  const previewResult = useMemo(() => {
    if (!previewPayload || previewNodeId == null) return null;
    const selectedNode = previewPayload.nodes.find((node) => node.id === previewNodeId);
    if (!selectedNode) return null;
    return {
      schemaVersion: 1,
      manifest: {
        board: previewPayload.board,
        boardText: previewPayload.boardText,
        solve: previewPayload.solve,
        economics: previewPayload.economics,
        coverage: previewPayload.coverage,
        releaseStatus: previewPayload.preview?.releaseStatus
      },
      nodes: previewPayload.nodes,
      selectedNode
    };
  }, [previewNodeId, previewPayload]);

  const updateForm = (key, value) => setForm((current) => ({ ...current, [key]: value }));
  const requestBody = useMemo(() => ({
    schemaVersion: 1,
    board: form.boardCards.join(''),
    potBb: Number(form.potBb),
    effectiveStackBb: Number(form.effectiveStackBb),
    ranges: {
      oop: form.oopRange.format === 'f32le-base64'
        ? { format: 'f32le-base64', data: form.oopRange.data }
        : { format: 'text', value: form.oopRange.value },
      ip: form.ipRange.format === 'f32le-base64'
        ? { format: 'f32le-base64', data: form.ipRange.data }
        : { format: 'text', value: form.ipRange.value }
    },
    economics: {
      model: form.economicModel,
      rakeRate: Number(form.rakeRate),
      rakeCapBb: Number(form.rakeCapBb),
      flatDropThresholdBb: Number(form.flatDropThresholdBb),
      flatDropAmountBb: Number(form.flatDropAmountBb)
    },
    treePolicyId: TREE_POLICY_ID,
    tree: {
      betsPotFraction: form.treeBetSizes,
      raisePotAfterCallFraction: Number(form.raisePotAfterCallFraction),
      allInRemainingStackFraction: Number(form.allInRemainingStackFraction)
    },
    solve: {
      maxIterations: Number(form.maxIterations),
      targetExploitabilityPotFraction: Number(form.targetExploitabilityPotFraction)
    },
    export: {
      streets: form.exportStreets,
      nodeLimit: 512,
      turnCardLimit: Number(form.turnCardLimit),
      riverCardLimit: Number(form.riverCardLimit),
      turnCard: form.exportStreets === 'flop' ? null : form.runoutCards[0],
      riverCard: form.exportStreets === 'flop-turn-river' ? form.runoutCards[1] : null
    }
  }), [form]);

  const selectTreePreset = (preset) => {
    setForm((current) => ({ ...current, treeBetSizes: TREE_PRESETS[preset] }));
  };

  const toggleTreeSize = (street, size) => {
    const selected = form.treeBetSizes[street];
    if (selected.includes(size) && selected.length === 1) {
      setError('每条街至少保留一个下注尺寸');
      return;
    }
    if (!selected.includes(size) && selected.length >= 4) {
      setError('每条街最多选择四个下注尺寸，避免动作树过大');
      return;
    }
    setError('');
    const next = selected.includes(size)
      ? selected.filter((value) => value !== size)
      : [...selected, size].sort((left, right) => left - right);
    setForm((current) => ({
      ...current,
      treeBetSizes: { ...current.treeBetSizes, [street]: next }
    }));
  };

  const selectAccuracyPreset = (preset) => {
    setForm((current) => ({
      ...current,
      maxIterations: preset.iterations,
      targetExploitabilityPotFraction: preset.target
    }));
  };

  const refreshJobs = async () => {
    const payload = await listSolverJobs();
    setJobs(payload.jobs);
    return payload.jobs;
  };

  useEffect(() => {
    if (FIRST_VISIT_PREVIEW) return undefined;
    let cancelled = false;
    Promise.allSettled([getSolverHealth(), listSolverJobs()])
      .then(([healthResult, jobsResult]) => {
        if (cancelled) return;
        setHealth(healthResult.status === 'fulfilled'
          ? healthResult.value
          : { status: healthResult.reason?.payload?.status ?? 'offline' });
        if (jobsResult.status === 'fulfilled') {
          setJobs(jobsResult.value.jobs);
          const candidate = jobsResult.value.jobs.find((job) => ACTIVE_STATUSES.has(job.status)) || jobsResult.value.jobs[0];
          if (candidate) setActiveJob(candidate);
        }
      })
      .finally(() => !cancelled && setLoading(false));
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    fetch(PRODUCTION_PREVIEW_MANIFEST_URL, { signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error(`样本目录读取失败（HTTP ${response.status}）`);
        return response.json();
      })
      .then((payload) => {
        if (
          payload?.schemaVersion !== 1 ||
          payload?.releaseStatus !== 'candidate-preview' ||
          payload?.releaseEligible !== false ||
          !Array.isArray(payload?.samples) ||
          payload.samples.length === 0
        ) {
          throw new Error('生产样本目录格式不符合预览约束');
        }
        setPreviewManifest(payload);
        setPreviewSampleId(payload.samples[0].id);
      })
      .catch((cause) => {
        if (cause.name !== 'AbortError') {
          setPreviewError(cause.message);
          setPreviewLoading(false);
        }
      });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (!activePreviewSample) return undefined;
    const controller = new AbortController();
    fetch(`${PRODUCTION_PREVIEW_BASE_URL}/${activePreviewSample.asset}`, { signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error(`牌面数据读取失败（HTTP ${response.status}）`);
        return response.json();
      })
      .then((payload) => {
        if (
          payload?.format !== 'kishpoker-postflop-solver-website-export-v1' ||
          payload?.preview?.releaseStatus !== 'candidate-preview' ||
          !Array.isArray(payload?.nodes) ||
          payload.nodes.length !== activePreviewSample.decisionNodes
        ) {
          throw new Error('牌面样本格式或节点覆盖不完整');
        }
        setPreviewPayload(payload);
        setPreviewNodeId(payload.nodes[0].id);
        setPreviewSelectedHand(null);
        setPreviewLoading(false);
      })
      .catch((cause) => {
        if (cause.name !== 'AbortError') {
          setPreviewError(cause.message);
          setPreviewLoading(false);
        }
      });
    return () => controller.abort();
  }, [activePreviewSample]);

  useEffect(() => {
    if (!activeJobId) return undefined;
    let cancelled = false;
    const poll = async () => {
      try {
        const current = await getSolverJob(activeJobId);
        if (cancelled) return;
        setActiveJob(current);
        setJobs((items) => [current, ...items.filter((item) => item.id !== current.id)]);
        if (current.status === 'succeeded' && !result) {
          let nextResult = await getSolverResult(current.id, 0);
          if (pendingRunoutNavigation) {
            const targetNode = nextResult.nodes.find((candidate) => (
              sameHistory(candidate.history, pendingRunoutNavigation.history)
              && candidate.currentBoardText.join(',') === pendingRunoutNavigation.board.join(',')
            ));
            if (targetNode) nextResult = await getSolverResult(current.id, targetNode.id);
          }
          if (!cancelled) {
            setResult(nextResult);
            setSelectedHand(null);
            setPendingRunoutNavigation(null);
          }
        }
      } catch (cause) {
        if (!cancelled) setError(cause.message);
      }
    };
    void poll();
    if (!ACTIVE_STATUSES.has(activeJobStatus)) return () => { cancelled = true; };
    const timer = setInterval(poll, 1000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [activeJobId, activeJobStatus, pendingRunoutNavigation, result]);

  useEffect(() => {
    if (!tutorialOpen) return undefined;
    const closeOnEscape = (event) => {
      if (event.key === 'Escape') setTutorialOpen(false);
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [tutorialOpen]);

  useEffect(() => {
    if (!installWatching || health?.status === 'ready') return undefined;
    let cancelled = false;

    const detectInstalledEngine = async () => {
      try {
        const [nextHealth, payload] = await Promise.all([getSolverHealth(), listSolverJobs()]);
        if (cancelled) return;
        setHealth(nextHealth);
        setJobs(payload.jobs);
        const candidate = payload.jobs.find((job) => ACTIVE_STATUSES.has(job.status)) || payload.jobs[0];
        if (candidate) setActiveJob(candidate);
        if (nextHealth?.status === 'ready') {
          setInstallWatching(false);
          setError('');
        }
      } catch {
        if (cancelled) return;
        setHealth({ status: 'offline' });
        if (Date.now() - installStartedAtRef.current >= INSTALL_CONNECTION_TIMEOUT_MS) {
          setInstallWatching(false);
          setError('仍未检测到本地引擎。请确认已经双击下载的 EXE 并完成安装；如果 Windows 阻止运行，请打开“使用教程”查看处理方法。');
        }
      }
    };

    const firstCheck = window.setTimeout(() => void detectInstalledEngine(), 2200);
    const timer = window.setInterval(() => void detectInstalledEngine(), 2500);
    return () => {
      cancelled = true;
      window.clearTimeout(firstCheck);
      window.clearInterval(timer);
    };
  }, [health?.status, installWatching]);

  const submitSolverRequest = async (body, navigation = null) => {
    setError('');
    setResult(null);
    setSelectedHand(null);
    setPendingRunoutNavigation(navigation);
    try {
      const job = await createSolverJob(body);
      setActiveJob(job);
      setJobs((items) => [job, ...items.filter((item) => item.id !== job.id)]);
    } catch (cause) {
      setPendingRunoutNavigation(null);
      setError(cause.message);
    }
  };

  const start = () => submitSolverRequest(requestBody);

  const chooseJob = async (job) => {
    setError('');
    setActiveJob(job);
    setResult(null);
    setSelectedHand(null);
    if (job.status === 'succeeded') {
      try { setResult(await getSolverResult(job.id, 0)); }
      catch (cause) { setError(cause.message); }
    }
  };

  const chooseNode = async (nodeId) => {
    try {
      setResult(await getSolverResult(activeJob.id, nodeId));
      setSelectedHand(null);
    } catch (cause) {
      setError(cause.message);
    }
  };

  const selectEconomicModel = (model) => {
    setForm((current) => ({ ...current, economicModel: model, ...(ECONOMIC_PRESETS[model] ?? {}) }));
  };

  const beginInstallerSetup = () => {
    installStartedAtRef.current = Date.now();
    setInstallWatching(true);
    setError('');
  };

  const takenBoardCards = useMemo(
    () => new Set([
      ...form.boardCards,
      ...form.runoutCards,
      ...(pickerTarget?.sourceNode?.currentBoardText ?? [])
    ].filter(Boolean)),
    [form.boardCards, form.runoutCards, pickerTarget]
  );
  const currentRange = rangeEditorTarget ? form[rangeEditorTarget.field] : null;

  const pickBoardCard = (card) => {
    if (!pickerTarget) return;
    if (pickerTarget.kind === 'result-runout') {
      const sourceNode = pickerTarget.sourceNode;
      const index = pickerTarget.index;
      const nextRunoutCards = index === 0
        ? [card, null]
        : [sourceNode.currentBoardText[3], card];
      const navigation = {
        history: [
          ...sourceNode.history,
          {
            id: pickerTarget.action.id,
            actor: sourceNode.actor,
            street: sourceNode.street
          }
        ],
        board: [...sourceNode.currentBoardText, card]
      };
      setForm((current) => ({
        ...current,
        runoutCards: nextRunoutCards,
        exportStreets: index === 0 && current.exportStreets === 'flop'
          ? 'flop-turn'
          : current.exportStreets
      }));
      setPickerTarget(null);
      void submitSolverRequest({
        ...requestBody,
        export: {
          ...requestBody.export,
          streets: index === 0 && requestBody.export.streets === 'flop'
            ? 'flop-turn'
            : requestBody.export.streets,
          turnCard: nextRunoutCards[0],
          riverCard: index === 1 ? nextRunoutCards[1] : null
        }
      }, navigation);
      return;
    }
    setForm((current) => pickerTarget.kind === 'runout'
      ? {
          ...current,
          runoutCards: current.runoutCards.map((value, index) => (index === pickerTarget.index ? card : value))
        }
      : {
          ...current,
          boardCards: current.boardCards.map((value, index) => (index === pickerTarget.index ? card : value))
        });
    setPickerTarget(null);
  };

  const clearBoardCard = (index) => {
    setForm((current) => ({
      ...current,
      boardCards: current.boardCards.map((value, cardIndex) => (cardIndex === index ? null : value))
    }));
  };

  const clearRunoutCard = (index) => {
    setForm((current) => ({
      ...current,
      runoutCards: current.runoutCards.map((value, cardIndex) => (
        cardIndex === index || (index === 0 && cardIndex === 1) ? null : value
      ))
    }));
  };

  const openRangeEditor = (field) => {
    setRangeEditorTarget({ field, sessionId: Date.now() });
  };

  const choosePreviewSample = (sampleId) => {
    if (sampleId === previewSampleId) return;
    setPreviewSampleId(sampleId);
    setPreviewPayload(null);
    setPreviewNodeId(null);
    setPreviewSelectedHand(null);
    setPreviewError('');
    setPreviewLoading(true);
  };

  return (
    <main className="solver-workbench">
      <section className="solver-intro">
        <div><span>KioSolver · LOCAL ENGINE</span><h1>在线 KioSolver 工具</h1><p>在网页中配置牌面、范围和动作树，求解过程使用你电脑的 CPU 和内存，数据保留在本机。</p></div>
        <aside>
          <i className={health?.status === 'ready' ? 'ready' : ''} />
          <span>{loading ? '正在连接本地服务' : health?.status === 'ready' ? '本地引擎就绪' : installWatching ? '等待引擎启动' : '本地引擎未连接'}</span>
          <small>API v1 · 仅监听本机</small>
        </aside>
      </section>

      {health?.status === 'ready' && <section id="production-preview" className="solver-production-preview">
        <header>
          <div>
            <span>PRODUCTION SAMPLE · 384 ITERATIONS</span>
            <h2>全量生产任务 · 首批牌面预览</h2>
            <p>BTN 开池 2bb，BB 跟注后的单次加注底池；起始底池 4.5bb，有效后手 98bb。</p>
          </div>
          <b>候选预览 · 暂非正式发布</b>
        </header>
        <div className="solver-preview-facts">
          <div><span>抽水</span><strong>3% · 1.8bb CAP</strong><small>普通抽水已计入 40% rakeback</small></div>
          <div><span>JP 抽水</span><strong>30bb 起 · 1.5bb</strong><small>JP 不参与 rakeback</small></div>
          <div><span>完整动作树</span><strong>Flop 25% / 75%</strong><small>Turn 75% / 150% · River 33% / 75% / 150%</small></div>
          <div><span>当前可查看</span><strong>每个牌面 20 节点</strong><small>转牌、河牌参与回溯求解，预览仅导出翻牌节点</small></div>
        </div>
        {previewManifest && (
          <nav className="solver-preview-samples" aria-label="生产样本牌面">
            {previewManifest.samples.map((sample) => (
              <button
                type="button"
                key={sample.id}
                className={sample.id === previewSampleId ? 'active' : ''}
                aria-current={sample.id === previewSampleId ? 'true' : undefined}
                onClick={() => choosePreviewSample(sample.id)}
              >
                <span className="solver-preview-board">
                  {sample.boardText.map((card) => <i key={card} className={`suit-${card[1]}`}>{boardCardLabel(card)}</i>)}
                </span>
                <b>{sample.texture}</b>
                <small>{sample.description} · Exploitability {percentage(sample.finalExploitabilityPotFraction, 3)}</small>
              </button>
            ))}
          </nav>
        )}
        {previewLoading && <div className="solver-preview-loading"><i /><span>正在载入生产样本策略…</span></div>}
        {previewError && <div className="solver-preview-error" role="alert"><b>样本暂时无法载入</b><span>{previewError}</span></div>}
        {activePreviewSample && !previewLoading && !previewError && (
          <footer>
            <span>{activePreviewSample.board} · {activePreviewSample.decisionNodes} 个翻牌决策节点</span>
            <small>固定 384 轮 · SHA-256 {activePreviewSample.sha256.slice(0, 12)}… · 请重点核对范围、频率、EV 和行动线是否符合预期。</small>
          </footer>
        )}
      </section>}

      {health?.status === 'ready' && previewResult && (
        <div className="solver-production-preview-result">
          <ResultWorkspace
            result={previewResult}
            selectedHand={previewSelectedHand}
            onSelectHand={setPreviewSelectedHand}
            onSelectNode={(nodeId) => {
              setPreviewNodeId(nodeId);
              setPreviewSelectedHand(null);
            }}
            eyebrow="生产样本预览 · 384轮"
          />
        </div>
      )}

      {!loading && health?.status !== 'ready' && (
        <section className="solver-companion-setup">
          <div>
            <span>首次使用 · 只需安装一次</span>
            <h2>下载，然后双击 EXE</h2>
            <p>安装器会自动装好并启动引擎。完成后会回到这个网页并自动连接，不需要设置路径，也不需要手动关联。</p>
          </div>
          <div className="solver-companion-actions">
            <a href={COMPANION_DOWNLOAD_URL} download onClick={beginInstallerSetup}>
              <span aria-hidden="true">↓</span>
              <b>一键下载引擎</b>
              <small>Windows x64 · 34 MB</small>
            </a>
            <button type="button" onClick={() => setTutorialOpen(true)}>使用教程</button>
          </div>
          {installWatching && (
            <div className="solver-install-waiting" role="status">
              <i aria-hidden="true" />
              <span>正在等待引擎启动<small>下载完成后双击 EXE，安装成功会自动连接</small></span>
            </div>
          )}
        </section>
      )}

      {tutorialOpen && (
        <div className="solver-tutorial-backdrop" onMouseDown={(event) => {
          if (event.target === event.currentTarget) setTutorialOpen(false);
        }}>
          <section className="solver-tutorial-dialog" role="dialog" aria-modal="true" aria-labelledby="solver-tutorial-title">
            <header>
              <div><span>一分钟完成</span><h2 id="solver-tutorial-title">下载后，只做这三步</h2></div>
              <button type="button" aria-label="关闭使用教程" onClick={() => setTutorialOpen(false)}>×</button>
            </header>
            <div className="solver-tutorial-visual">
              <article>
                <b>1</b>
                <div className="solver-tutorial-scene solver-tutorial-download" aria-hidden="true"><i>↓</i><span>kishpoker-solver<br />-setup.exe</span></div>
                <h3>下载 EXE</h3>
                <p>点击“一键下载引擎”，等浏览器下载完成。</p>
              </article>
              <article>
                <b>2</b>
                <div className="solver-tutorial-scene solver-tutorial-run" aria-hidden="true"><span>EXE</span><i>双击</i></div>
                <h3>双击运行</h3>
                <p>打开下载的 EXE。若 Windows 拦截，点“更多信息”后选择“仍要运行”。</p>
              </article>
              <article>
                <b>3</b>
                <div className="solver-tutorial-scene solver-tutorial-ready" aria-hidden="true"><i /><span>本地引擎已连接</span></div>
                <h3>回到网页</h3>
                <p>安装完成会自动打开本页；看到“本地引擎就绪”即可开始。</p>
              </article>
            </div>
            <footer>
              <a href={COMPANION_DOWNLOAD_URL} download onClick={() => {
                beginInstallerSetup();
                setTutorialOpen(false);
              }}>一键下载引擎</a>
              <button type="button" onClick={() => setTutorialOpen(false)}>我知道了</button>
            </footer>
          </section>
        </div>
      )}

      {error && <div className="solver-global-error" role="alert"><b>出现问题</b><span>{error}</span><button type="button" onClick={() => setError('')}>关闭</button></div>}

      <div className="solver-builder-grid">
        <section className="solver-config-panel">
          <header><span>01 · INPUT</span><h2>求解配置</h2></header>
          <div className="solver-basic-fields">
            <div className="solver-board-field">
              <span>翻牌</span>
              <div className="card-slots board-cards solver-flop-cards">
                {form.boardCards.map((card, index) => {
                  const classes = ['card-slot', 'board-slot'];
                  if (card) classes.push('filled', `suit-${card[1]}`);
                  else classes.push('empty');
                  return (
                    <button
                      key={`solver-board-${index}`}
                      type="button"
                      className={classes.join(' ')}
                      onClick={() => setPickerTarget({ kind: 'flop', index, currentValue: card })}
                    >
                      <span className="card-face">
                        <span className="card-rank">{card?.[0] ?? '--'}</span>
                        <span className="card-pip">{card ? SUIT_ICON[card[1]] : ''}</span>
                      </span>
                      {card && (
                        <span className="slot-clear" onClick={(event) => { event.stopPropagation(); clearBoardCard(index); }}>×</span>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>
            <label><span>底池（bb）</span><input type="number" step="0.01" min="0.01" value={form.potBb} onChange={(event) => updateForm('potBb', event.target.value)} /></label>
            <label><span>有效筹码（bb）</span><input type="number" step="0.01" min="0.01" value={form.effectiveStackBb} onChange={(event) => updateForm('effectiveStackBb', event.target.value)} /></label>
          </div>
          {form.exportStreets !== 'flop' && (
            <div className="solver-runout-field">
              <span>指定出牌预览 <small>留空则自动选一张可用牌</small></span>
              <div className="solver-runout-slots">
                {form.runoutCards.map((card, index) => {
                  const disabled = index === 1 && (
                    form.exportStreets !== 'flop-turn-river' || !form.runoutCards[0]
                  );
                  const classes = ['solver-runout-slot'];
                  if (card) classes.push('filled', `suit-${card[1]}`);
                  return (
                    <button
                      key={`solver-runout-${index}`}
                      type="button"
                      className={classes.join(' ')}
                      disabled={disabled}
                      onClick={() => setPickerTarget({ kind: 'runout', index, currentValue: card })}
                    >
                      <small>{index === 0 ? 'TURN' : 'RIVER'}</small>
                      <b>{card ? boardCardLabel(card) : '选择牌'}</b>
                      {card && <span onClick={(event) => { event.stopPropagation(); clearRunoutCard(index); }}>×</span>}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
          <div className="solver-ranges">
            <SolverRangeSelector label="OOP 范围" value={form.oopRange} onChange={(value) => updateForm('oopRange', value)} onEdit={() => openRangeEditor('oopRange')} onError={setError} />
            <SolverRangeSelector label="IP 范围" value={form.ipRange} onChange={(value) => updateForm('ipRange', value)} onEdit={() => openRangeEditor('ipRange')} onError={setError} />
          </div>
          <div className="solver-section-label"><span>02 · ECONOMICS</span><h3>抽水模型</h3></div>
          <label className="solver-wide-field"><span>预设</span><select value={form.economicModel} onChange={(event) => selectEconomicModel(event.target.value)}><option value="gg-rnc-rb40">GG R&C · 40% 回馈后 3% / 1.8bb + JP</option><option value="gg-rnc-full-rake">GG R&C · 5% / 3bb + JP</option><option value="zero-rake">零抽水基准</option><option value="custom">自定义</option></select></label>
          <div className="solver-economic-fields">
            <label><span>比例</span><input type="number" step="0.01" min="0" max="1" value={form.rakeRate} onChange={(event) => updateForm('rakeRate', event.target.value)} /></label>
            <label><span>封顶 bb</span><input type="number" step="0.01" min="0" value={form.rakeCapBb} onChange={(event) => updateForm('rakeCapBb', event.target.value)} /></label>
            <label><span>JP 门槛 bb</span><input type="number" step="0.01" min="0" value={form.flatDropThresholdBb} onChange={(event) => updateForm('flatDropThresholdBb', event.target.value)} /></label>
            <label><span>JP 金额 bb</span><input type="number" step="0.01" min="0" value={form.flatDropAmountBb} onChange={(event) => updateForm('flatDropAmountBb', event.target.value)} /></label>
          </div>
          <div className="solver-section-label"><span>03 · TREE & SOLVE</span><h3>动作树与精度</h3></div>
          <div className="solver-tree-policy">
            <header>
              <span>下注尺寸（可多选，每街最多 4 个）</span>
              <div className="solver-tree-presets">
                <button type="button" onClick={() => selectTreePreset('fast')}>轻量</button>
                <button type="button" onClick={() => selectTreePreset('standard')}>标准</button>
                <button type="button" onClick={() => selectTreePreset('detailed')}>细分</button>
              </div>
            </header>
            {Object.entries(TREE_SIZE_OPTIONS).map(([street, options]) => (
              <div className="solver-tree-street" key={street}>
                <span>{street.toUpperCase()}</span>
                <div>
                  {options.map((size) => {
                    const selected = form.treeBetSizes[street].includes(size);
                    return (
                      <button
                        type="button"
                        key={size}
                        className={selected ? 'active' : ''}
                        aria-pressed={selected}
                        onClick={() => toggleTreeSize(street, size)}
                      >
                        {Math.round(size * 100)}%
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
            <div className="solver-tree-advanced">
              <label><span>加注尺寸（跟注后底池）</span><select value={form.raisePotAfterCallFraction} onChange={(event) => updateForm('raisePotAfterCallFraction', event.target.value)}><option value="0.5">50%</option><option value="0.66">66%</option><option value="0.75">75%</option><option value="1">100%</option><option value="1.25">125%</option><option value="1.5">150%</option></select></label>
              <label><span>转 All-in 阈值（剩余筹码）</span><select value={form.allInRemainingStackFraction} onChange={(event) => updateForm('allInRemainingStackFraction', event.target.value)}><option value="0.25">25%</option><option value="0.33">33%</option><option value="0.5">50%</option><option value="0.67">67%</option><option value="0.75">75%</option></select></label>
            </div>
            <p>尺寸越多，树越大、耗时和内存越高。加注百分比按“先跟注后的底池”计算；行动后剩余筹码低于所选阈值时合并为 All-in。</p>
          </div>
          <div className="solver-accuracy-presets">
            <span>精度快捷选项</span>
            <div>{ACCURACY_PRESETS.map((preset) => <button type="button" key={preset.id} onClick={() => selectAccuracyPreset(preset)}>{preset.label}<small>{preset.iterations} 轮{preset.target > 0 ? ` · ≤ ${(preset.target * 100).toFixed(1)}% pot` : ''}</small></button>)}</div>
          </div>
          <div className="solver-solve-fields">
            <label><span>最大迭代</span><input type="number" min="1" max="100000" value={form.maxIterations} onChange={(event) => updateForm('maxIterations', event.target.value)} /></label>
            <label><span>目标 exploitability / pot</span><input type="number" step="0.0001" min="0" max="1" value={form.targetExploitabilityPotFraction} onChange={(event) => updateForm('targetExploitabilityPotFraction', event.target.value)} /></label>
            <label><span>查看街道</span><select value={form.exportStreets} onChange={(event) => updateForm('exportStreets', event.target.value)}><option value="flop">只看 Flop</option><option value="flop-turn">Flop + Turn</option><option value="flop-turn-river">Flop + Turn + River（推荐）</option></select></label>
            {form.exportStreets !== 'flop' && !form.runoutCards[0] && <label><span>Turn 自动出牌数</span><input type="number" min="1" max="49" value={form.turnCardLimit} onChange={(event) => updateForm('turnCardLimit', event.target.value)} /></label>}
            {form.exportStreets === 'flop-turn-river' && !form.runoutCards[1] && <label><span>每个 Turn 的 River 自动出牌数</span><input type="number" min="1" max="48" value={form.riverCardLimit} onChange={(event) => updateForm('riverCardLimit', event.target.value)} /></label>}
          </div>
          <div className="solver-run-actions">
            <button type="button" className="solver-run" disabled={health?.status !== 'ready' || !form.boardCards.every(Boolean) || ACTIVE_STATUSES.has(activeJob?.status)} onClick={start}>启动求解</button>
            <button type="button" className="solver-stop" disabled={!ACTIVE_STATUSES.has(activeJob?.status)} onClick={async () => setActiveJob(await stopSolverJob(activeJob.id))}>停止</button>
          </div>
        </section>

        <aside className="solver-side-column">
          <StatusPanel job={activeJob} />
          <section className="solver-job-history">
            <header><span>最近任务</span><button type="button" onClick={() => void refreshJobs()}>刷新</button></header>
            {jobs.length === 0 && <p>还没有持久化任务。</p>}
            {jobs.slice(0, 8).map((job) => (
              <button type="button" key={job.id} className={job.id === activeJob?.id ? 'active' : ''} onClick={() => void chooseJob(job)}>
                <i className={`solver-dot solver-dot--${job.status}`} /><span><b>{job.inputSha256.slice(0, 12)}</b><small>{dateLabel(job.createdAt)}</small></span><em>{STATUS_LABELS[job.status]}</em>
              </button>
            ))}
          </section>
          {activeJob && ['failed', 'stopped', 'interrupted'].includes(activeJob.status) && <button type="button" className="solver-retry" onClick={async () => { const job = await retrySolverJob(activeJob.id); setActiveJob(job); setResult(null); }}>按相同输入重试</button>}
          {activeJob?.status === 'succeeded' && <a className="solver-export" href={solverExportUrl(activeJob.id)} download>导出网站数据 <span>JSON · SHA-256 {activeJob.result?.sha256.slice(0, 12)}</span></a>}
        </aside>
      </div>

      {result && <ResultWorkspace result={result} selectedHand={selectedHand} onSelectHand={setSelectedHand} onSelectNode={(id) => void chooseNode(id)} onChooseRunout={({ action, node, index }) => setPickerTarget({ kind: 'result-runout', action, sourceNode: node, index, currentValue: null })} />}

      <CardPickerModal
        open={Boolean(pickerTarget)}
        currentValue={pickerTarget?.currentValue ?? null}
        takenCards={takenBoardCards}
        onClose={() => setPickerTarget(null)}
        onSelect={pickBoardCard}
        title={pickerTarget?.kind === 'runout' || pickerTarget?.kind === 'result-runout' ? `选择${pickerTarget.index === 0 ? '转牌' : '河牌'}` : '选择翻牌'}
      />

      <RangeEditor
        key={rangeEditorTarget?.sessionId ?? 'solver-range-editor'}
        open={Boolean(rangeEditorTarget)}
        title={`${rangeEditorTarget?.field === 'oopRange' ? 'OOP' : 'IP'} · 范围`}
        range={currentRange?.map ?? {}}
        onClose={() => setRangeEditorTarget(null)}
        onChange={(nextRange) => {
          if (rangeEditorTarget?.field) {
            updateForm(rangeEditorTarget.field, {
              format: 'text',
              value: rangeMapToSolverText(nextRange),
              map: nextRange
            });
          }
        }}
      />
    </main>
  );
}
