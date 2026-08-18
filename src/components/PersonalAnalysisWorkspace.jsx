import { useEffect, useMemo, useState } from 'react';
import { useAuth } from '../auth/AuthProvider.jsx';
import {
  loadCloudLibraryIndex,
  loadCloudLibrarySessionHands
} from '../lib/cloudLibrary.js';
import {
  acceptOperatorArchivePreference,
  archiveImportedHands,
  disableOperatorArchivePreference,
  getOperatorArchivePreference,
  resolveOperatorArchiveConsent
} from '../lib/operatorArchive.js';
import { summarizeHeroResults } from '../lib/handHistoryAnalyzer.js';
import {
  clearPersonalAnalysisCache,
  loadPersonalAnalysisCache,
  prunePersonalAnalysisCache,
  savePersonalAnalysisSessions
} from '../lib/personalAnalysisCache.js';
import { DatasetFilterPanel } from './DatasetFilterPanel.jsx';
import './PersonalAnalysisWorkspace.css';

const EMPTY_FILTERS = Object.freeze({
  timePreset: 'all',
  dateFrom: '',
  dateTo: '',
  stakes: Object.freeze([]),
  gameTypes: Object.freeze([])
});

function emptyFilters() {
  return { ...EMPTY_FILTERS, stakes: [], gameTypes: [] };
}

function localDateKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function filterDateRange(filters, now = new Date()) {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const preset = filters.timePreset || 'all';
  if (preset === 'custom') return { from: filters.dateFrom || '', to: filters.dateTo || '' };
  if (preset === 'today') {
    const value = localDateKey(today);
    return { from: value, to: value };
  }
  if (preset === 'week') {
    const monday = new Date(today);
    const weekday = monday.getDay() || 7;
    monday.setDate(monday.getDate() - weekday + 1);
    return { from: localDateKey(monday), to: localDateKey(today) };
  }
  if (preset === 'month') {
    return { from: localDateKey(new Date(today.getFullYear(), today.getMonth(), 1)), to: localDateKey(today) };
  }
  if (preset === 'last30') {
    const start = new Date(today);
    start.setDate(start.getDate() - 29);
    return { from: localDateKey(start), to: localDateKey(today) };
  }
  return { from: '', to: '' };
}

function resultDateKey(result) {
  const match = String(result?.date ?? '').match(/^(\d{4})[/-](\d{2})[/-](\d{2})/);
  return match ? `${match[1]}-${match[2]}-${match[3]}` : '';
}

function resultGameTypeKey(result) {
  return `${result?.gameVariant ?? 'unknown'}:${result?.bettingStructure ?? 'unknown'}:${result?.tableType ?? 'unknown'}:${Number.isInteger(result?.maxPlayers) ? result.maxPlayers : 'unknown'}`;
}

function resultMatchesFilters(result, filters) {
  const range = filterDateRange(filters);
  const date = resultDateKey(result);
  if (range.from && (!date || date < range.from)) return false;
  if (range.to && (!date || date > range.to)) return false;
  if (filters.stakes?.length && !filters.stakes.includes(result?.stakes)) return false;
  if (filters.gameTypes?.length && !filters.gameTypes.includes(resultGameTypeKey(result))) return false;
  return true;
}

function sessionCouldMatchFilters(session, filters) {
  const range = filterDateRange(filters);
  const startedAt = String(session?.startedAt ?? '').slice(0, 10);
  const endedAt = String(session?.endedAt ?? session?.startedAt ?? '').slice(0, 10);
  if (range.from && endedAt && endedAt < range.from) return false;
  if (range.to && startedAt && startedAt > range.to) return false;
  if (filters.stakes?.length) {
    const sessionStakes = new Set((session?.summary?.stakes ?? []).map((item) => item?.label).filter(Boolean));
    if (sessionStakes.size && !filters.stakes.some((stake) => sessionStakes.has(stake))) return false;
  }
  if (filters.gameTypes?.length) {
    const sessionGameTypes = new Set((session?.summary?.gameTypes ?? []).map((item) => item?.key).filter(Boolean));
    if (sessionGameTypes.size && !filters.gameTypes.some((gameType) => sessionGameTypes.has(gameType))) return false;
  }
  return true;
}

function resultSortValue(result) {
  const normalized = String(result?.date ?? '').replace(/^(\d{4})\/(\d{2})\/(\d{2})/, '$1-$2-$3');
  const timestamp = Date.parse(normalized);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

const MAX_SESSION_BATCH_HANDS = 12000;
const MAX_SESSIONS_PER_BATCH = 12;

function analysisSessionBatches(sessions) {
  const batches = [];
  let current = [];
  let handCount = 0;
  for (const session of sessions) {
    const nextHands = Math.max(1, Number(session?.handCount ?? 0) || 1);
    if (current.length && (
      current.length >= MAX_SESSIONS_PER_BATCH
      || handCount + nextHands > MAX_SESSION_BATCH_HANDS
    )) {
      batches.push(current);
      current = [];
      handCount = 0;
    }
    current.push(session);
    handCount += nextHands;
  }
  if (current.length) batches.push(current);
  return batches;
}

function percentage(value, digits = 1) {
  const number = Number(value);
  return Number.isFinite(number) ? `${number.toFixed(digits)}%` : '—';
}

function signed(value, digits = 1, suffix = '') {
  const number = Number(value);
  if (!Number.isFinite(number)) return '—';
  return `${number > 0 ? '+' : ''}${number.toFixed(digits)}${suffix}`;
}

function metricTone(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number === 0) return '';
  return number > 0 ? 'positive' : 'negative';
}

function compactNumber(value, digits = 1) {
  const number = Number(value);
  if (!Number.isFinite(number)) return '—';
  return number.toLocaleString('zh-CN', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits
  });
}

const CURVE_LINES = [
  { key: 'beforeRakeBB', label: '水前实际盈利', color: '#22c55e' },
  { key: 'evBB', label: '水前 All-in EV', color: '#facc15' },
  { key: 'profitBB', label: '水后盈利', color: '#a78bfa' },
  { key: 'nonShowdownBB', label: '非摊牌', color: '#ef4444' },
  { key: 'showdownBB', label: '摊牌', color: '#38bdf8' }
];
const DEFAULT_CURVE_LINES = ['beforeRakeBB', 'evBB', 'profitBB'];
const MAX_CURVE_POINTS = 1800;

function niceStep(value) {
  if (!Number.isFinite(value) || value <= 0) return 1;
  const exponent = Math.floor(Math.log10(value));
  const base = 10 ** exponent;
  const fraction = value / base;
  if (fraction <= 1) return base;
  if (fraction <= 2) return 2 * base;
  if (fraction <= 5) return 5 * base;
  return 10 * base;
}

function sampleCurve(data) {
  if (data.length <= MAX_CURVE_POINTS) return data;
  const step = Math.ceil((data.length - 1) / (MAX_CURVE_POINTS - 1));
  const sampled = [];
  for (let index = 0; index < data.length; index += step) sampled.push(data[index]);
  const last = data[data.length - 1];
  if (sampled[sampled.length - 1] !== last) sampled.push(last);
  return sampled;
}

function PerformanceCurve({ data = [] }) {
  const [visibleLineKeys, setVisibleLineKeys] = useState(() => new Set(DEFAULT_CURVE_LINES));
  const [hoverIndex, setHoverIndex] = useState(null);
  const sampledData = useMemo(() => sampleCurve(data), [data]);

  if (data.length < 2) {
    return <div className="personal-analysis-curve-empty">至少需要 2 手牌才能绘制资金曲线</div>;
  }

  const width = 920;
  const height = 340;
  const padLeft = 58;
  const padRight = 136;
  const padTop = 24;
  const padBottom = 44;
  const hands = data.length;
  const visibleLines = CURVE_LINES.filter((line) => visibleLineKeys.has(line.key));
  let rawMin = 0;
  let rawMax = 0;
  for (const point of data) {
    for (const line of visibleLines) {
      const value = Number(point[line.key] ?? 0);
      rawMin = Math.min(rawMin, value);
      rawMax = Math.max(rawMax, value);
    }
  }
  const yStep = niceStep(Math.max(1, rawMax - rawMin) / 5);
  const minY = Math.floor(rawMin / yStep) * yStep;
  const maxY = Math.max(yStep, Math.ceil(rawMax / yStep) * yStep);
  const span = maxY - minY || 1;
  const plotWidth = width - padLeft - padRight;
  const plotHeight = height - padTop - padBottom;
  const xByHand = (hand) => padLeft + (Math.max(1, hand) - 1) / (hands - 1) * plotWidth;
  const y = (value) => height - padBottom - (Number(value ?? 0) - minY) / span * plotHeight;
  const tickCount = 5;
  const yTicks = Array.from({ length: tickCount + 1 }, (_, index) => minY + index * (maxY - minY) / tickCount).reverse();
  const xTicks = [...new Set(Array.from(
    { length: 6 },
    (_, index) => Math.max(1, Math.round(1 + index * (hands - 1) / 5))
  ))];
  const hoverData = hoverIndex == null ? null : data[hoverIndex];

  const toggleLine = (key) => {
    setVisibleLineKeys((current) => {
      const next = new Set(current);
      if (next.has(key)) {
        if (next.size === 1) return current;
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  };

  const updateHover = (event) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const svgX = (event.clientX - rect.left) / rect.width * width;
    const rawIndex = (svgX - padLeft) / plotWidth * (hands - 1);
    setHoverIndex(Math.max(0, Math.min(hands - 1, Math.round(rawIndex))));
  };

  return (
    <div className="personal-analysis-curve-wrap">
      <svg
        className="personal-analysis-curve"
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label="个人牌库资金曲线"
        onMouseMove={updateHover}
        onMouseLeave={() => setHoverIndex(null)}
      >
        {yTicks.map((tick) => (
          <g key={tick.toFixed(4)}>
            <line x1={padLeft} y1={y(tick)} x2={width - padRight} y2={y(tick)} className="personal-analysis-grid-line" />
            <text x={padLeft - 10} y={y(tick) + 4} textAnchor="end" className="personal-analysis-axis-label">{compactNumber(tick, 0)}</text>
          </g>
        ))}
        {xTicks.map((tick) => (
          <text key={tick} x={xByHand(tick)} y={height - 13} textAnchor="middle" className="personal-analysis-axis-label">{tick.toLocaleString()}</text>
        ))}
        <line x1={padLeft} y1={y(0)} x2={width - padRight} y2={y(0)} className="personal-analysis-zero-line" />
        {visibleLines.map((line, lineIndex) => {
          const path = sampledData.map((point, index) => (
            `${index === 0 ? 'M' : 'L'} ${xByHand(point.hand).toFixed(1)} ${y(point[line.key]).toFixed(1)}`
          )).join(' ');
          const finalValue = Number(data[data.length - 1]?.[line.key] ?? 0);
          const labelOffset = (lineIndex - (visibleLines.length - 1) / 2) * 13;
          const labelY = Math.min(height - 48, Math.max(18, y(finalValue) + labelOffset));
          return (
            <g key={line.key}>
              <path d={path} className="personal-analysis-curve-line" style={{ stroke: line.color }} />
              <circle cx={xByHand(hands)} cy={y(finalValue)} r="3" style={{ fill: line.color }} />
              <text x={width - padRight + 10} y={labelY} className="personal-analysis-curve-end" style={{ fill: line.color }}>
                {compactNumber(finalValue / hands * 100, 2)} BB/100
              </text>
            </g>
          );
        })}
        {hoverData && (
          <g>
            <line x1={xByHand(hoverData.hand)} y1={padTop} x2={xByHand(hoverData.hand)} y2={height - padBottom} className="personal-analysis-hover-line" />
            {visibleLines.map((line) => <circle key={line.key} cx={xByHand(hoverData.hand)} cy={y(hoverData[line.key])} r="4" style={{ fill: line.color }} />)}
          </g>
        )}
        <text x={padLeft} y={14} className="personal-analysis-axis-title">盈利（BB）</text>
        <text x={padLeft + plotWidth / 2} y={height - 1} textAnchor="middle" className="personal-analysis-axis-title">手数</text>
      </svg>
      {hoverData && (
        <div className="personal-analysis-curve-hover" role="status">
          <strong>第 {hoverData.hand.toLocaleString()} 手</strong>
          {visibleLines.map((line) => (
            <span key={line.key} style={{ color: line.color }}>
              {line.label} {signed(hoverData[line.key], 1, ' BB')}
            </span>
          ))}
        </div>
      )}
      <div className="personal-analysis-curve-legend" aria-label="资金曲线显示项目">
        {CURVE_LINES.map((line) => (
          <button key={line.key} type="button" className={visibleLineKeys.has(line.key) ? 'active' : ''} aria-pressed={visibleLineKeys.has(line.key)} onClick={() => toggleLine(line.key)}>
            <i style={{ background: line.color }} />{line.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function gameTypeLabel(item) {
  if (item?.label) return item.label;
  const [variant, structure, tableType, players] = String(item?.key || '').split(':');
  return [variant, structure, tableType, players && players !== 'unknown' ? `${players}人桌` : '']
    .filter((value) => value && value !== 'unknown')
    .join(' · ') || '未知游戏类型';
}

function archiveStatusText(result) {
  if (!result) return '';
  if (result.totalCount === 0) return '当前筛选没有可分析的牌谱。';
  if (result.status === 'completed') return `贡献副本已完成去重同步，共处理 ${result.totalCount.toLocaleString()} 手牌。`;
  return `已建立安全续传任务：完成 ${Number(result.completedCount || 0).toLocaleString()}，待传 ${Number(result.queuedCount || 0).toLocaleString()} 手牌。`;
}

const DATA_GROUPS = [
  {
    title: '翻前结构',
    desc: '整座牌谱库按同一口径汇总；每个频率下方同时显示真实机会次数。',
    metrics: [
      { label: 'VPIP', path: 'vpip', opportunityPath: 'totalHands' },
      { label: 'PFR', path: 'pfr', opportunityPath: 'totalHands' },
      { label: '3Bet', path: 'threeBet', opportunityPath: 'facingThreeBet' },
      { label: 'Squeeze', path: 'squeeze', opportunityPath: 'squeezeOpportunityCount' },
      { label: '4Bet', path: 'fourBet', opportunityPath: 'fourBetOpportunityCount' },
      { label: 'Fold to 3Bet', path: 'foldToThreeBet', opportunityPath: 'foldToThreeBetOpportunityCount' },
      { label: 'Fold to 4Bet', path: 'foldToFourBet', opportunityPath: 'foldToFourBetOpportunityCount' },
      { label: 'Steal Total', path: 'stealTotal', opportunityPath: 'stealOpportunityCount' },
      { label: 'Steal BTN', path: 'stealBtn', opportunityPath: 'stealBtnOpportunityCount' },
      { label: 'Steal SB', path: 'stealSb', opportunityPath: 'stealSbOpportunityCount' }
    ]
  },
  {
    title: '翻牌圈',
    desc: '拆分持续下注、面对持续下注、Donk 和 Check 后的应对。',
    metrics: [
      { label: 'CBet', path: 'postflop.flop.cbet', opportunityPath: 'postflop.flop.cbetOpportunity' },
      { label: 'CBet IP', path: 'postflop.flop.cbetIp', opportunityPath: 'postflop.flop.cbetIpOpportunity' },
      { label: 'CBet OOP', path: 'postflop.flop.cbetOop', opportunityPath: 'postflop.flop.cbetOopOpportunity' },
      { label: 'Fold to CBet', path: 'postflop.flop.foldToCbet', opportunityPath: 'postflop.flop.foldToCbetOpportunity' },
      { label: 'Fold to CBet IP', path: 'postflop.flop.foldToCbetIp', opportunityPath: 'postflop.flop.foldToCbetIpOpportunity' },
      { label: 'Fold to CBet OOP', path: 'postflop.flop.foldToCbetOop', opportunityPath: 'postflop.flop.foldToCbetOopOpportunity' },
      { label: 'Donk', path: 'postflop.flop.donk', opportunityPath: 'postflop.flop.donkOpportunity' },
      { label: 'Check-Call', path: 'postflop.flop.checkCall', opportunityPath: 'postflop.flop.checkResponseOpportunity' },
      { label: 'Check-Raise', path: 'postflop.flop.checkRaise', opportunityPath: 'postflop.flop.checkResponseOpportunity' }
    ]
  },
  {
    title: '转牌圈',
    desc: '转牌圈使用与 Session 详细数据一致的统计定义。',
    metrics: [
      { label: 'CBet', path: 'postflop.turn.cbet', opportunityPath: 'postflop.turn.cbetOpportunity' },
      { label: 'CBet IP', path: 'postflop.turn.cbetIp', opportunityPath: 'postflop.turn.cbetIpOpportunity' },
      { label: 'CBet OOP', path: 'postflop.turn.cbetOop', opportunityPath: 'postflop.turn.cbetOopOpportunity' },
      { label: 'Fold to CBet', path: 'postflop.turn.foldToCbet', opportunityPath: 'postflop.turn.foldToCbetOpportunity' },
      { label: 'Donk', path: 'postflop.turn.donk', opportunityPath: 'postflop.turn.donkOpportunity' },
      { label: 'Check-Call', path: 'postflop.turn.checkCall', opportunityPath: 'postflop.turn.checkResponseOpportunity' },
      { label: 'Check-Raise', path: 'postflop.turn.checkRaise', opportunityPath: 'postflop.turn.checkResponseOpportunity' }
    ]
  },
  {
    title: '河牌圈',
    desc: '河牌圈使用与 Session 详细数据一致的统计定义。',
    metrics: [
      { label: 'CBet', path: 'postflop.river.cbet', opportunityPath: 'postflop.river.cbetOpportunity' },
      { label: 'CBet IP', path: 'postflop.river.cbetIp', opportunityPath: 'postflop.river.cbetIpOpportunity' },
      { label: 'CBet OOP', path: 'postflop.river.cbetOop', opportunityPath: 'postflop.river.cbetOopOpportunity' },
      { label: 'Fold to CBet', path: 'postflop.river.foldToCbet', opportunityPath: 'postflop.river.foldToCbetOpportunity' },
      { label: 'Donk', path: 'postflop.river.donk', opportunityPath: 'postflop.river.donkOpportunity' },
      { label: 'Check-Call', path: 'postflop.river.checkCall', opportunityPath: 'postflop.river.checkResponseOpportunity' },
      { label: 'Check-Raise', path: 'postflop.river.checkRaise', opportunityPath: 'postflop.river.checkResponseOpportunity' }
    ]
  },
  {
    title: '摊牌表现',
    desc: '到达摊牌、摊牌胜率和看翻牌后获胜率。',
    metrics: [
      { label: 'WWSF', path: 'wwsf', opportunityPath: 'sawFlopCount' },
      { label: 'WTSD', path: 'wtsd', opportunityPath: 'sawFlopCount' },
      { label: 'W$SD', path: 'wsd', opportunityPath: 'showdownCount' }
    ]
  }
];

function valueAt(object, path) {
  return path.split('.').reduce((value, key) => value?.[key], object);
}

function heroResultFromCloudHand(hand) {
  if (!hand || typeof hand.getHeroResult !== 'function') return null;
  const candidates = [...new Set([hand.analysisHero, ...(hand.heroCandidates ?? [])])].filter(Boolean);
  for (const hero of candidates) {
    const result = hand.getHeroResult(hero);
    if (result) return result;
  }
  return null;
}

export function PersonalAnalysisWorkspace() {
  const { authStatus, isAuthenticated, openLogin } = useAuth();
  const [loadState, setLoadState] = useState('idle');
  const [library, setLibrary] = useState(null);
  const [sessions, setSessions] = useState([]);
  const [filters, setFilters] = useState(() => emptyFilters());
  const [consent, setConsent] = useState(null);
  const [consentChoice, setConsentChoice] = useState(() => getOperatorArchivePreference());
  const [consentChecked, setConsentChecked] = useState(false);
  const [consentBusy, setConsentBusy] = useState(false);
  const [analysisState, setAnalysisState] = useState('idle');
  const [analysisResults, setAnalysisResults] = useState([]);
  const [analysisSessionIds, setAnalysisSessionIds] = useState([]);
  const [skippedAnalysisHands, setSkippedAnalysisHands] = useState(0);
  const [analysisMessage, setAnalysisMessage] = useState('');
  const [error, setError] = useState('');
  const [activeTab, setActiveTab] = useState('overview');

  useEffect(() => {
    if (!isAuthenticated) {
      setLibrary(null);
      setSessions([]);
      setConsent(null);
      setAnalysisResults([]);
      setAnalysisSessionIds([]);
      setSkippedAnalysisHands(0);
      setAnalysisState('idle');
      setLoadState('idle');
      return undefined;
    }

    let active = true;
    setLoadState('loading');
    setError('');
    Promise.all([
      loadCloudLibraryIndex(),
      resolveOperatorArchiveConsent().catch(() => null)
    ]).then(([index, currentConsent]) => {
      if (!active) return;
      setLibrary(index.library);
      setSessions(index.sessions);
      setConsent(currentConsent);
      setConsentChoice(currentConsent ? 'accepted' : getOperatorArchivePreference());
      setLoadState('ready');
    }).catch((requestError) => {
      if (!active) return;
      setError(requestError instanceof Error ? requestError.message : '无法读取个人牌谱库。');
      setLoadState('error');
    });
    return () => { active = false; };
  }, [isAuthenticated]);

  const totalHands = useMemo(
    () => sessions.reduce((sum, session) => sum + Number(session.handCount || 0), 0),
    [sessions]
  );
  const stakeOptions = useMemo(() => {
    const counts = new Map();
    sessions.forEach((session) => (session.summary?.stakes || []).forEach((item) => {
      const value = item?.label;
      if (value) counts.set(value, (counts.get(value) || 0) + Number(item.count || 0));
    }));
    return [...counts.entries()].map(([value, count]) => ({ value, label: value, count }));
  }, [sessions]);
  const gameTypeOptions = useMemo(() => {
    const values = new Map();
    sessions.forEach((session) => (session.summary?.gameTypes || []).forEach((item) => {
      if (!item?.key || item.analysisSupported === false) return;
      const current = values.get(item.key);
      if (current) current.count += Number(item.count || 0);
      else values.set(item.key, { value: item.key, label: gameTypeLabel(item), count: Number(item.count || 0) });
    }));
    return [...values.values()];
  }, [sessions]);
  const filteredAnalysisResults = useMemo(
    () => analysisResults.filter((result) => resultMatchesFilters(result, filters)),
    [analysisResults, filters]
  );
  const summary = useMemo(
    () => summarizeHeroResults(filteredAnalysisResults),
    [filteredAnalysisResults]
  );
  const accessGranted = Boolean(isAuthenticated && consent && consentChoice === 'accepted');

  const updateAnalysisFilters = (nextFilters) => {
    setFilters(nextFilters);
    if (analysisState === 'loading' || !analysisSessionIds.length) return;
    const loadedIds = new Set(analysisSessionIds);
    const requiredSessions = sessions.filter((session) => sessionCouldMatchFilters(session, nextFilters));
    const cacheCoversFilter = requiredSessions.every((session) => loadedIds.has(String(session.id)));
    if (!cacheCoversFilter) {
      setAnalysisState('idle');
      setAnalysisMessage('该筛选包含尚未缓存的 Session，请点击“分析所选牌谱”完成增量同步。');
      return;
    }
    const resultCount = analysisResults.filter((result) => resultMatchesFilters(result, nextFilters)).length;
    setAnalysisState(resultCount ? 'ready' : 'empty');
    setAnalysisMessage(resultCount
      ? `已使用本机缓存即时筛选出 ${resultCount.toLocaleString()} 手牌。`
      : '当前筛选没有牌谱，请调整时间、级别或游戏类型。');
  };

  const acceptAccess = async () => {
    if (!consentChecked || consentBusy) return;
    setConsentBusy(true);
    setError('');
    try {
      const nextConsent = await acceptOperatorArchivePreference();
      setConsent(nextConsent);
      setConsentChoice('accepted');
      setConsentChecked(false);
      setAnalysisMessage('高级分析权限已开启。选择样本后，K2note 会先建立去重续传任务，再生成报告。');
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : '无法开启高级分析权限。');
    } finally {
      setConsentBusy(false);
    }
  };

  const revokeAccess = async () => {
    if (consentBusy) return;
    if (!window.confirm('停止贡献后，高级数据分析与漏洞分析会立即锁定；免登录 Session 基础分析不受影响。确定继续吗？')) return;
    setConsentBusy(true);
    setError('');
    try {
      const cacheIdentity = consent?.subjectId;
      const cacheLibraryId = library?.id;
      await disableOperatorArchivePreference();
      setConsent(null);
      setConsentChoice('local-only');
      setAnalysisResults([]);
      setAnalysisSessionIds([]);
      setSkippedAnalysisHands(0);
      setAnalysisState('idle');
      setAnalysisMessage('已停止贡献，高级分析已锁定。');
      if (cacheIdentity && cacheLibraryId) {
        await clearPersonalAnalysisCache({ subjectId: cacheIdentity, libraryId: cacheLibraryId }).catch(() => null);
      }
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : '停止高级分析权限失败。');
    } finally {
      setConsentBusy(false);
    }
  };

  const runAnalysis = async () => {
    if (!library || !accessGranted || analysisState === 'loading') return;
    setAnalysisState('loading');
    setAnalysisResults([]);
    setAnalysisSessionIds([]);
    setSkippedAnalysisHands(0);
    setError('');
    setAnalysisMessage('正在检查本机缓存与云端 Session 索引…');
    try {
      const currentConsent = await resolveOperatorArchiveConsent();
      if (!currentConsent) {
        setConsent(null);
        setConsentChoice(null);
        throw new Error('贡献授权已失效，请重新确认后再使用高级分析。');
      }

      const targetSessions = sessions.filter((session) => sessionCouldMatchFilters(session, filters));
      if (!targetSessions.length) {
        setAnalysisState('empty');
        setAnalysisMessage('当前筛选没有牌谱，请调整时间、级别或游戏类型。');
        return;
      }

      let cached = { results: [], cachedSessionIds: [], cachedSourceHandCount: 0, cachedResultCount: 0 };
      let cacheAvailable = true;
      try {
        cached = await loadPersonalAnalysisCache({
          subjectId: currentConsent.subjectId,
          libraryId: library.id,
          consentToken: currentConsent.consentToken,
          sessions: targetSessions
        });
      } catch {
        cacheAvailable = false;
      }

      const cachedSessionIds = new Set(cached.cachedSessionIds);
      const missingSessions = targetSessions.filter((session) => !cachedSessionIds.has(String(session.id)));
      let freshResults = [];
      let freshSourceHandCount = 0;
      let archiveResult = null;

      if (missingSessions.length) {
        const cachedHands = Number(cached.cachedResultCount || cached.results.length);
        setAnalysisMessage(cachedHands
          ? `已命中 ${cachedHands.toLocaleString()} 手牌缓存，正在增量读取 ${missingSessions.length.toLocaleString()} 个 Session…`
          : `首次建立本机分析缓存，正在读取 ${missingSessions.length.toLocaleString()} 个 Session…`);

        const batches = analysisSessionBatches(missingSessions);
        for (let batchIndex = 0; batchIndex < batches.length; batchIndex += 1) {
          const batchSessions = batches[batchIndex];
          setAnalysisMessage(`正在增量读取第 ${(batchIndex + 1).toLocaleString()}/${batches.length.toLocaleString()} 批 Session…`);
          const cloudResult = await loadCloudLibrarySessionHands({
            libraryId: library.id,
            sessionIds: batchSessions.map((session) => session.id)
          });
          const batchIds = new Set(batchSessions.map((session) => String(session.id)));
          const fallbackSessionId = batchSessions.length === 1 ? String(batchSessions[0].id) : '';
          const freshHands = cloudResult.hands.filter((hand) => {
            const sessionId = String(hand.analysisSessionId || fallbackSessionId);
            return batchIds.has(sessionId);
          });
          freshSourceHandCount += freshHands.length;

          if (freshHands.length) {
            setAnalysisMessage(`正在为第 ${(batchIndex + 1).toLocaleString()}/${batches.length.toLocaleString()} 批的 ${freshHands.length.toLocaleString()} 手牌建立去重贡献副本…`);
            archiveResult = await archiveImportedHands({
              hands: freshHands,
              consent: currentConsent,
              onProgress: ({ message }) => message && setAnalysisMessage(message)
            });
            if (archiveResult.status === 'cancelled') throw new Error('贡献副本任务已取消，高级分析未解锁。');
          }

          const handsBySession = new Map(batchSessions.map((session) => [String(session.id), []]));
          for (const hand of freshHands) {
            const sessionId = String(hand.analysisSessionId || fallbackSessionId);
            handsBySession.get(sessionId)?.push(hand);
          }
          const cacheEntries = batchSessions.map((session) => {
            const sessionHands = handsBySession.get(String(session.id)) ?? [];
            const results = sessionHands.map(heroResultFromCloudHand).filter(Boolean);
            freshResults.push(...results);
            return { session, results, sourceHandCount: sessionHands.length };
          });

          if (cacheAvailable) {
            try {
              await savePersonalAnalysisSessions({
                subjectId: currentConsent.subjectId,
                libraryId: library.id,
                consentToken: currentConsent.consentToken,
                entries: cacheEntries
              });
            } catch {
              cacheAvailable = false;
            }
          }
        }
      }

      if (cacheAvailable) {
        prunePersonalAnalysisCache({
          subjectId: currentConsent.subjectId,
          libraryId: library.id,
          consentToken: currentConsent.consentToken,
          activeSessionIds: sessions.map((session) => session.id)
        }).catch(() => null);
      }

      const allResults = [...cached.results, ...freshResults]
        .sort((first, second) => resultSortValue(first) - resultSortValue(second));
      const selectedResults = allResults.filter((result) => resultMatchesFilters(result, filters));
      setAnalysisResults(allResults);
      setAnalysisSessionIds(targetSessions.map((session) => String(session.id)));
      if (!selectedResults.length) {
        setAnalysisState('empty');
        setAnalysisMessage('当前筛选没有牌谱，请调整时间、级别或游戏类型。');
        return;
      }

      setSkippedAnalysisHands(Math.max(
        0,
        Number(cached.cachedSourceHandCount || 0) + freshSourceHandCount
          - Number(cached.cachedResultCount || cached.results.length) - freshResults.length
      ));
      setAnalysisState('ready');
      const cacheText = cacheAvailable
        ? `本机缓存 ${cached.cachedSessionIds.length + missingSessions.length}/${targetSessions.length} 个 Session`
        : '当前浏览器无法使用持久缓存，本次结果仅保留到页面关闭';
      setAnalysisMessage(archiveResult
        ? `${archiveStatusText(archiveResult)} · ${cacheText}`
        : `已直接使用缓存生成报告 · ${cacheText}`);
    } catch (requestError) {
      setAnalysisState('error');
      setError(requestError instanceof Error ? requestError.message : '高级分析准备失败。');
    }
  };

  if (authStatus === 'loading') {
    return <section className="personal-analysis-state"><i aria-hidden="true" /><h2>正在确认登录状态…</h2></section>;
  }

  if (!isAuthenticated) {
    return (
      <section className="personal-analysis-gate personal-analysis-gate--guest">
        <div className="personal-analysis-lock" aria-hidden="true">K2</div>
        <p className="eyebrow">K2note MEMBER ANALYTICS</p>
        <h1>登录后分析你的长期牌谱</h1>
        <p>免登录用户仍可分析当前 Session；长期数据分析、漏洞分析和个性化建议只面向登录并同意贡献牌谱副本的用户。</p>
        <div className="personal-analysis-requirements">
          <span><i>1</i><strong>登录 K2note</strong><small>手机号或 Google</small></span>
          <span><i>2</i><strong>使用个人牌谱库</strong><small>只读取你的数据</small></span>
          <span><i>3</i><strong>贡献牌谱副本</strong><small>免费高级分析的条件</small></span>
        </div>
        <div className="personal-analysis-gate-actions">
          <button type="button" className="primary" onClick={() => openLogin({ returnTo: '/?tool=insights' })}>登录 / 注册并继续</button>
          <button type="button" className="secondary" onClick={() => window.location.assign('?tool=history')}>仅分析当前 Session</button>
        </div>
      </section>
    );
  }

  if (loadState === 'loading') {
    return <section className="personal-analysis-state"><i aria-hidden="true" /><h2>正在读取你的个人牌谱库…</h2></section>;
  }

  return (
    <div className="personal-analysis-workspace">
      <header className="personal-analysis-hero">
        <div>
          <p className="eyebrow">K2note PERSONAL INTELLIGENCE</p>
          <h1>个人数据分析工作台</h1>
          <p>从你的长期牌谱库选择样本，先完成贡献副本的去重同步，再生成个人数据与漏洞报告。</p>
        </div>
        <div className="personal-analysis-access-strip" aria-label="高级分析访问条件">
          <span className="complete"><i>✓</i>已登录</span>
          <span className={library && totalHands > 0 ? 'complete' : ''}><i>{library && totalHands > 0 ? '✓' : '2'}</i>个人牌谱库</span>
          <span className={accessGranted ? 'complete' : ''}><i>{accessGranted ? '✓' : '3'}</i>贡献授权</span>
        </div>
      </header>

      {error && <div className="personal-analysis-error" role="alert">{error}</div>}

      {!accessGranted && (
        <section className="personal-analysis-gate personal-analysis-gate--consent">
          <div>
            <p className="eyebrow">FREE ACCESS CONDITION</p>
            <h2>免费使用高级分析，需要贡献所分析的牌谱</h2>
            <p>K2note 会把你在高级分析中选择的已识别 GG 原始牌谱建立运营分析副本，用于玩家池研究、统计口径校验和改进产品。个人牌谱库与运营副本仍分别存储。</p>
          </div>
          <div className="personal-analysis-consent-scope">
            <strong>本次授权包含</strong>
            <ul>
              <li>所选牌谱可能包含玩家名、行动、底牌、公共牌和输赢。</li>
              <li>服务器按牌谱内容去重；重复分析不会制造重复牌谱。</li>
              <li>停止贡献后，高级分析会锁定，但 Session 基础分析继续免费可用。</li>
              <li>可按现有副本删除机制撤回并删除本设备贡献的数据。</li>
            </ul>
          </div>
          <label className="personal-analysis-consent-check">
            <input type="checkbox" checked={consentChecked} onChange={(event) => setConsentChecked(event.target.checked)} />
            <span>我已阅读<a href="/?page=privacy" target="_blank" rel="noreferrer">《隐私政策》</a>，同意将高级分析所使用的牌谱贡献给 K2note。</span>
          </label>
          <div className="personal-analysis-gate-actions">
            <button type="button" className="primary" disabled={!consentChecked || consentBusy} onClick={acceptAccess}>{consentBusy ? '正在开启…' : '同意条件并开启高级分析'}</button>
            <button type="button" className="secondary" onClick={() => window.location.assign('?tool=history')}>返回 Session 基础分析</button>
          </div>
        </section>
      )}

      {accessGranted && totalHands === 0 && (
        <section className="personal-analysis-state personal-analysis-state--empty">
          <span aria-hidden="true">＋</span>
          <h2>个人牌谱库还是空的</h2>
          <p>先导入并保存一批 GG 牌谱，之后即可在这里选择长期样本。</p>
          <button type="button" className="primary" onClick={() => window.location.assign('?tool=history')}>导入第一个 Session</button>
        </section>
      )}

      {accessGranted && totalHands > 0 && (
        <>
          <section className="personal-analysis-selector">
            <header>
              <div><span>01 · DATASET</span><h2>选择分析样本</h2></div>
              <button type="button" className="personal-analysis-revoke" disabled={consentBusy} onClick={revokeAccess}>停止贡献并锁定高级分析</button>
            </header>
            <DatasetFilterPanel
              filters={filters}
              onChange={updateAnalysisFilters}
              onClear={() => updateAnalysisFilters(emptyFilters())}
              stakeOptions={stakeOptions}
              gameTypeOptions={gameTypeOptions}
              filteredCount={analysisState === 'ready' || analysisState === 'empty' ? filteredAnalysisResults.length : null}
              totalCount={totalHands}
              title="筛选个人牌谱库"
              disabled={analysisState === 'loading'}
            />
            <div className="personal-analysis-runbar">
              <p><strong>{library?.name || '我的牌谱'}</strong><span>共 {totalHands.toLocaleString()} 手牌 · 首次建立本机缓存，之后只同步新增或变化的 Session</span></p>
              <button type="button" className="primary" disabled={analysisState === 'loading'} onClick={runAnalysis}>{analysisState === 'loading' ? '正在同步并分析…' : '分析所选牌谱'}</button>
            </div>
            {analysisMessage && <div className={`personal-analysis-progress personal-analysis-progress--${analysisState}`}><i aria-hidden="true" /><span>{analysisMessage}</span></div>}
          </section>

          {analysisState === 'ready' && (
            <section className="personal-analysis-report">
              <header className="personal-analysis-report-heading">
                <div>
                  <span>02 · REPORT</span>
                  <h2>{filteredAnalysisResults.length.toLocaleString()} 手牌分析结果</h2>
                  {skippedAnalysisHands > 0 && <small className="personal-analysis-report-warning">{skippedAnalysisHands.toLocaleString()} 手牌缺少 Hero 标识，未计入统计</small>}
                </div>
                <div className="personal-analysis-tabs" role="tablist" aria-label="个人分析报告">
                  <button type="button" className={activeTab === 'overview' ? 'active' : ''} onClick={() => setActiveTab('overview')}>总览</button>
                  <button type="button" className={activeTab === 'data' ? 'active' : ''} onClick={() => setActiveTab('data')}>数据分析</button>
                  <button type="button" className={activeTab === 'leaks' ? 'active' : ''} onClick={() => setActiveTab('leaks')}>漏洞分析</button>
                </div>
              </header>

              {activeTab === 'overview' && (
                <>
                  <div className="personal-analysis-kpis">
                    <article><span>样本</span><strong>{summary.totalHands.toLocaleString()}</strong><small>手牌</small></article>
                    <article><span>累计输赢</span><strong className={metricTone(summary.totalProfitBB)}>{signed(summary.totalProfitBB, 1, ' BB')}</strong><small>水后结果</small></article>
                    <article><span>百手盈利</span><strong className={metricTone(summary.bbPer100)}>{signed(summary.bbPer100, 2)}</strong><small>BB / 100</small></article>
                    <article><span>VPIP / PFR</span><strong>{percentage(summary.vpip, 1)} <i>/</i> {percentage(summary.pfr, 1)}</strong><small>翻前结构</small></article>
                    <article><span>3Bet</span><strong>{percentage(summary.threeBet, 1)}</strong><small>{summary.facingThreeBet.toLocaleString()} 次机会</small></article>
                    <article><span>WWSF</span><strong>{percentage(summary.wwsf, 1)}</strong><small>{summary.sawFlopCount.toLocaleString()} 次看翻牌</small></article>
                  </div>
                  <section className="personal-analysis-curve-card">
                    <header>
                      <div>
                        <span>LONG-TERM PERFORMANCE</span>
                        <h3>整座牌谱库资金曲线</h3>
                        <small>
                          {summary.allInEvOpportunityCount
                            ? `All-in EV 覆盖 ${summary.allInEvCoveredCount}/${summary.allInEvOpportunityCount} 手${summary.allInEvEstimatedCount ? ` · ${summary.allInEvEstimatedCount} 手翻前估算` : ''}`
                            : '当前样本没有需要调整的 All-in 手牌'}
                        </small>
                      </div>
                      <em>单位：BB</em>
                    </header>
                    <PerformanceCurve data={summary.curve} />
                  </section>
                  <section className="personal-analysis-result-grid" aria-label="长期结果数据">
                    <article><span>水后盈利</span><strong className={metricTone(summary.totalProfitBB)}>{signed(summary.totalProfitBB, 1, ' BB')}</strong><small>{signed(summary.bbPer100, 2, ' BB/100')}</small></article>
                    <article><span>水前盈利</span><strong className={metricTone(summary.beforeRakeProfitBB)}>{signed(summary.beforeRakeProfitBB, 1, ' BB')}</strong><small>{signed(summary.beforeRakeBBPer100, 2, ' BB/100')}</small></article>
                    <article><span>水前 All-in EV</span><strong className={metricTone(summary.allInEvBeforeRakeBB)}>{signed(summary.allInEvBeforeRakeBB, 1, ' BB')}</strong><small>{signed(summary.allInEvBBPer100, 2, ' BB/100')}</small></article>
                    <article><span>总抽水</span><strong>{compactNumber(summary.totalRake, 2)} USD</strong><small>{compactNumber(summary.rakeBBPer100, 2)} BB/100</small></article>
                    <article><span>游戏抽水</span><strong>{compactNumber(summary.gameRake, 2)} USD</strong><small>{compactNumber(summary.gameRakeBBPer100, 2)} BB/100</small></article>
                    <article><span>JP 抽水</span><strong>{compactNumber(summary.totalJackpot, 2)} USD</strong><small>{compactNumber(summary.jackpotRakeBBPer100, 2)} BB/100</small></article>
                  </section>
                  <section className="personal-analysis-breakdowns">
                    <article>
                      <header><span>POSITION</span><h3>位置分布</h3></header>
                      <div>{summary.positions.map((item) => {
                        const ratio = summary.totalHands ? item.count / summary.totalHands * 100 : 0;
                        return <p key={item.label}><span>{item.label}</span><i><b style={{ width: `${ratio}%` }} /></i><strong>{item.count.toLocaleString()}</strong></p>;
                      })}</div>
                    </article>
                    <article>
                      <header><span>STAKES</span><h3>级别分布</h3></header>
                      <div>{[...summary.stakes].sort((a, b) => b.count - a.count).map((item) => {
                        const ratio = summary.totalHands ? item.count / summary.totalHands * 100 : 0;
                        return <p key={item.label}><span>{item.label}</span><i><b style={{ width: `${ratio}%` }} /></i><strong>{item.count.toLocaleString()}</strong></p>;
                      })}</div>
                    </article>
                  </section>
                  <div className="personal-analysis-roadmap">
                    <article><span>已接入</span><h3>长期数据汇总</h3><p>当前样本的盈利、核心频率、位置和级别数据已经使用真实牌谱计算。</p></article>
                    <article><span>下一步</span><h3>诊断规则引擎</h3><p>为每项指标增加样本门槛、合理区间、偏差程度和解释文本。</p></article>
                    <article><span>下一步</span><h3>行动线漏洞排序</h3><p>按损失、频率偏差、样本可信度和可改进空间生成优先级。</p></article>
                  </div>
                </>
              )}

              {activeTab === 'data' && (
                <div className="personal-analysis-data-groups">
                  {DATA_GROUPS.map((group) => (
                    <article key={group.title}>
                      <header><div><span>LIBRARY DATA</span><h3>{group.title}</h3></div><small>与 Session 使用同一统计口径</small></header>
                      <p>{group.desc}</p>
                      <div>{group.metrics.map((metric) => {
                        const opportunities = valueAt(summary, metric.opportunityPath);
                        return (
                          <span key={metric.path}>
                            <small>{metric.label}</small>
                            <strong>{percentage(valueAt(summary, metric.path), 1)}</strong>
                            <em>{Number(opportunities || 0).toLocaleString()} 次机会</em>
                          </span>
                        );
                      })}</div>
                    </article>
                  ))}
                </div>
              )}

              {activeTab === 'leaks' && (
                <div className="personal-analysis-leak-shells">
                  <article><i>01</i><span>样本可信度</span><h3>判断哪些数据值得下结论</h3><p>将结合机会次数、手数和置信区间，避免用小样本误判打法。</p><strong>接口已预留 · 规则待接入</strong></article>
                  <article><i>02</i><span>翻前漏洞</span><h3>寻找频率偏差最大的节点</h3><p>计划覆盖位置、面对动作、3Bet/4Bet、偷盲和盲注防守。</p><strong>接口已预留 · 规则待接入</strong></article>
                  <article><i>03</i><span>翻后漏洞</span><h3>拆解行动线与下注尺度</h3><p>计划按街道、位置、牌面、底池类型和行动顺序定位问题。</p><strong>接口已预留 · 规则待接入</strong></article>
                  <article><i>04</i><span>优先改进</span><h3>把问题转成复盘清单</h3><p>最终将按预估损失、可信度和可执行性输出优先级。</p><strong>接口已预留 · 规则待接入</strong></article>
                </div>
              )}
            </section>
          )}
        </>
      )}
    </div>
  );
}
